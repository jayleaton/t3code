import {
  createRoutedGatewayPort,
  GATEWAY_SCOPE_VALUES,
  type GatewayScope,
} from "@t3tools/client-runtime/gateway";
import { GatewayError, type GatewayToolContext } from "@t3tools/mcp-gateway";
import {
  failure,
  GATEWAY_ONLY_TOOLS,
  requestContext,
  requiresEnvironment,
  runGatewayTool,
  TOOL_SPECS,
  toolInputJsonSchema,
  type ToolSpec,
} from "@t3tools/mcp-gateway/catalog";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTaskService from "../../threadTask/ThreadTaskService.ts";
import { McpGatewayBroker } from "../McpGatewayBroker.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
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

/** Tools that deliver text to another chat; managed workers report through their task instead. */
const MESSAGE_TOOLS: ReadonlySet<string> = new Set(["t3_send_message", "t3_answer_question"]);

/** Gateway tools that only read. Every other tool changes something and is declared a write. */
const READ_TOOL = /^t3_(?:list|get|summarize)_|^t3_(?:git_status|task_read|task_watch|task_board)$/;

const specOf = (name: string) => (TOOL_SPECS as Record<string, ToolSpec>)[name]!;

const AGENTS_TOOL_NAMES = Object.keys(TOOL_SPECS).filter((name) => !GATEWAY_ONLY_TOOLS.has(name));

// The gateway validates arguments against the catalog's own schema (agentsToolInputSchema),
// so the toolkit passes the object through.
const agentsTool = (name: string) =>
  Tool.make(name, {
    description: specOf(name)[0],
    parameters: Schema.Record(Schema.String, Schema.Unknown),
    success: Schema.instanceOf(McpSchema.CallToolResult),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
  });

/** The T3 Agents tools this server's `t3-code` MCP hosts: every one that needs no event store. */
export const AgentsToolkit = Toolkit.make(...AGENTS_TOOL_NAMES.map(agentsTool));

/** The catalog's input schema; a tool's environmentId defaults to this server's own. */
export const agentsToolInputSchema = (name: string) =>
  toolInputJsonSchema(name, { environmentDefault: true }) as McpSchema.Tool["inputSchema"];

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

/** How a call refused before reaching the gateway reads to the agent: a gateway failure. */
export const agentsToolRefusal = (error: unknown, args: Record<string, unknown>) =>
  toCallToolResult(
    failure(
      isOrchestratorMcpFailure(error)
        ? new GatewayError({ code: "scope_required", message: error.message, retryable: false })
        : error,
      requestContext(args),
    ),
  );

/** Whether this server hosts the Agents tools; servers without the in-process port host none. */
export const hostsAgentsTools = Effect.map(Effect.serviceOption(LocalGatewayPort), Option.isSome);

/** The tools' handlers, each declaring who may call it (see McpToolAccess). */
export const layer = McpToolAccess.toLayer(
  AgentsToolkit,
  Effect.gen(function* () {
    const tasks = Option.getOrUndefined(
      yield* Effect.serviceOption(ThreadTaskService.ThreadTaskService),
    );
    const local = Option.getOrUndefined(yield* Effect.serviceOption(LocalGatewayPort));
    const broker = Option.getOrUndefined(yield* Effect.serviceOption(McpGatewayBroker));
    const relay = broker && {
      invoke: (
        method: string,
        args: ReadonlyArray<unknown>,
        environmentIds: ReadonlyArray<string>,
      ) => Effect.runPromise(broker.invoke(method, args, environmentIds)),
    };
    const context: GatewayToolContext | undefined = local && {
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

    const handle = (name: string) => {
      const defaultEnvironment = requiresEnvironment(name);
      return (payload: Readonly<Record<string, unknown>>) =>
        Effect.gen(function* () {
          const invocation = yield* McpInvocationContext.McpInvocationContext;
          const args = { ...payload };
          if (local === undefined || context === undefined) {
            return toCallToolResult(
              failure(new Error("This server hosts no T3 Agents tools."), requestContext(args)),
            );
          }
          if (defaultEnvironment && typeof args.environmentId !== "string") {
            args.environmentId = local.environmentId;
          }
          if (!invocation.capabilities.has("orchestration")) {
            return toCallToolResult(
              failure(
                new Error("This chat's MCP credential cannot use T3 Agents tools."),
                requestContext(args),
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
          // Task tools stay with this server as the calling chat (see createRoutedGatewayPort).
          if (caller === undefined || !MESSAGE_TOOLS.has(name) || tasks === undefined) {
            return yield* run;
          }
          // A worker on another environment cannot be messaging its own child.
          const targetThreadId =
            args.environmentId === local.environmentId && typeof args.threadId === "string"
              ? ThreadId.make(args.threadId)
              : null;
          return yield* tasks
            .authorizeMessage({ senderThreadId: ThreadId.make(caller.threadId), targetThreadId })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.succeed(
                    toCallToolResult(
                      failure(
                        new GatewayError({
                          code: "scope_required",
                          message: error.detail,
                          retryable: false,
                        }),
                        requestContext(args),
                      ),
                    ),
                  ),
                onSuccess: () => run,
              }),
            );
        });
    };

    return Object.fromEntries(
      AGENTS_TOOL_NAMES.map((name) => [
        name,
        READ_TOOL.test(name)
          ? McpToolAccess.reads(handle(name))
          : McpToolAccess.writes(handle(name)),
      ]),
    );
  }),
);
