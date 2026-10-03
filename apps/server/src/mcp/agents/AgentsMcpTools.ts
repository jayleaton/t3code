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
import { McpSchema, McpServer } from "effect/unstable/ai";

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

const registerAgentsTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
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
          const caller = { environmentId: local.environmentId, threadId: invocation.threadId };
          return Effect.promise(() => runGatewayTool(context, name, args, { caller })).pipe(
            Effect.map((run) => toCallToolResult(run.result)),
          );
        }),
    });
  }
});

/** Adds the T3 Agents tools to this server's `t3-code` MCP. */
export const AgentsToolsRegistrationLive = Layer.effectDiscard(registerAgentsTools);
