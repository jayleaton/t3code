import {
  createRoutedGatewayPort,
  GATEWAY_SCOPE_VALUES,
  type GatewayScope,
} from "@t3tools/client-runtime/gateway";
import type { GatewayToolContext } from "@t3tools/mcp-gateway";
import {
  failure,
  GATEWAY_ONLY_TOOLS,
  requestContext,
  requiresEnvironment,
  runGatewayTool,
  TOOL_SPECS,
  toolInputJsonSchema,
} from "@t3tools/mcp-gateway/catalog";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { ThreadId } from "@t3tools/contracts";

import * as ThreadTaskService from "../../threadTask/ThreadTaskService.ts";
import { McpGatewayBroker } from "../McpGatewayBroker.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";

type ToolResult = {
  readonly isError?: boolean;
  readonly content: unknown;
  readonly structuredContent: unknown;
};

// Agents in a thread act with every scope on their own machine; other machines apply the
// grants the user set on the T3 app relaying the call.
const LOCAL_GRANTS = [...GATEWAY_SCOPE_VALUES];
const isScope = (scope: string): scope is GatewayScope =>
  (GATEWAY_SCOPE_VALUES as ReadonlyArray<string>).includes(scope);

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// Gateway envelopes can hold `undefined` fields, which MCP's JSON schema rejects. Their text
// content is the same body as JSON, so structured content is read back from it.
const toCallToolResult = (result: ToolResult) => {
  const content = result.content as McpSchema.CallToolResult["content"];
  const [first] = content;
  return new McpSchema.CallToolResult({
    isError: result.isError === true,
    structuredContent: (first?.type === "text"
      ? decodeJsonText(first.text)
      : result.structuredContent) as Record<string, unknown>,
    content,
  });
};

/** Task tools act as the calling chat, which only this environment can authenticate. */
const TASK_TOOLS: ReadonlySet<string> = new Set([
  "t3_task_assign",
  "t3_task_read",
  "t3_task_update",
  "t3_task_watch",
  "t3_settle_after_turn",
]);

/** Tools that deliver text to another chat; managed workers report through their task instead. */
const MESSAGE_TOOLS: ReadonlySet<string> = new Set(["t3_send_message", "t3_answer_question"]);

const registerAgentsTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const tasks = Option.getOrUndefined(
    yield* Effect.serviceOption(ThreadTaskService.ThreadTaskService),
  );
  const localOption = yield* Effect.serviceOption(LocalGatewayPort);
  // Servers composed without the in-process port (for example MCP tests) host no agent tools.
  if (Option.isNone(localOption)) return;
  const local = localOption.value;
  const broker = Option.getOrUndefined(yield* Effect.serviceOption(McpGatewayBroker));
  const relay = broker && {
    invoke: (method: string, args: ReadonlyArray<unknown>, environmentIds: ReadonlyArray<string>) =>
      Effect.runPromise(broker.invoke(method, args, environmentIds)),
  };
  const context: GatewayToolContext = {
    port: createRoutedGatewayPort(local.environmentId, local.port, () =>
      relay && broker.available() ? relay : undefined,
    ),
    grants: () => {
      const relayed = Object.entries(broker?.grants() ?? {}).map(
        ([environmentId, scopes]) => [environmentId, scopes.filter(isScope)] as const,
      );
      return { ...Object.fromEntries(relayed), [local.environmentId]: LOCAL_GRANTS };
    },
  };

  for (const [name, [description]] of Object.entries(TOOL_SPECS)) {
    if (GATEWAY_ONLY_TOOLS.has(name)) continue;
    const defaultEnvironment = requiresEnvironment(name);
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name,
        description,
        inputSchema: toolInputJsonSchema(name, {
          environmentDefault: true,
        }) as McpSchema.Tool["inputSchema"],
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          const args = { ...(payload as Record<string, unknown> | undefined) };
          if (defaultEnvironment && typeof args.environmentId !== "string") {
            args.environmentId = local.environmentId;
          }
          if (!invocation.capabilities.has("orchestration")) {
            return Effect.succeed(
              toCallToolResult(
                failure(
                  new Error("This chat's MCP credential cannot use T3 Agents tools."),
                  requestContext(args),
                ),
              ),
            );
          }
          // An OAuth client has no calling thread; the gateway then needs explicit targets.
          const caller =
            invocation.thread === undefined
              ? undefined
              : { environmentId: local.environmentId, threadId: invocation.thread.threadId };
          const run = Effect.promise(() => runGatewayTool(context, name, args, { caller })).pipe(
            Effect.map((run) => toCallToolResult(run.result)),
          );
          // Routing would drop the caller and act as the user, so an agent's task call stays here.
          if (
            caller !== undefined &&
            TASK_TOOLS.has(name) &&
            args.environmentId !== local.environmentId
          ) {
            return Effect.succeed(
              toCallToolResult(
                failure(
                  new Error(
                    "Task tools act as your chat and run only on its own environment; another environment cannot verify which chat you are.",
                  ),
                  requestContext(args),
                ),
              ),
            );
          }
          if (caller === undefined || !MESSAGE_TOOLS.has(name) || tasks === undefined) return run;
          // A worker on another environment cannot be messaging its own child.
          const targetThreadId =
            args.environmentId === local.environmentId && typeof args.threadId === "string"
              ? ThreadId.make(args.threadId)
              : null;
          return tasks
            .authorizeMessage({ senderThreadId: ThreadId.make(caller.threadId), targetThreadId })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.succeed(
                    toCallToolResult(failure(new Error(error.detail), requestContext(args))),
                  ),
                onSuccess: () => run,
              }),
            );
        }),
    });
  }
});

/** Adds the T3 Agents tools to this server's `t3-code` MCP. */
export const AgentsToolsRegistrationLive = Layer.effectDiscard(registerAgentsTools);
