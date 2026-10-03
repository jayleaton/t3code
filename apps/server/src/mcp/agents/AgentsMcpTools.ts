import { GATEWAY_SCOPE_VALUES } from "@t3tools/client-runtime/gateway";
import type { GatewayToolContext } from "@t3tools/mcp-gateway";
import { McpGatewayUnavailableError } from "@t3tools/contracts";
import {
  failure,
  requestContext,
  ROUTER_TOOLS,
  runGatewayTool,
  TOOL_SPECS,
  toolInputJsonSchema,
} from "@t3tools/mcp-gateway/catalog";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";

type ToolResult = {
  readonly isError?: boolean;
  readonly content: unknown;
  readonly structuredContent: unknown;
};

/**
 * Runs a T3 Agents tool on another environment through a connected client. Absent when no
 * client can relay, in which case such calls fail with a clear message.
 */
export class AgentsRemoteRelay extends Context.Service<
  AgentsRemoteRelay,
  {
    readonly call: (input: {
      readonly environmentId: string;
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly caller: { readonly environmentId: string; readonly threadId: string };
    }) => Effect.Effect<ToolResult, McpGatewayUnavailableError>;
  }
>()("t3/mcp/agents/AgentsMcpTools/AgentsRemoteRelay") {}

// Agents in a thread act with every gateway scope on their own machine; other machines apply
// the grants the user set on the relaying client.
const LOCAL_GRANTS = [...GATEWAY_SCOPE_VALUES];

const toCallToolResult = (result: ToolResult) =>
  new McpSchema.CallToolResult({
    isError: result.isError === true,
    structuredContent: result.structuredContent as Record<string, unknown>,
    content: result.content as McpSchema.CallToolResult["content"],
  });

const registerAgentsTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const localOption = yield* Effect.serviceOption(LocalGatewayPort);
  // Servers composed without the in-process port (for example MCP tests) host no agent tools.
  if (Option.isNone(localOption)) return;
  const local = localOption.value;
  const relay = yield* Effect.serviceOption(AgentsRemoteRelay);
  const context: GatewayToolContext = {
    port: local.port,
    grants: { [local.environmentId]: LOCAL_GRANTS },
  };

  for (const [name, [description]] of Object.entries(TOOL_SPECS)) {
    if (ROUTER_TOOLS.has(name)) continue;
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
          const rawArgs = (payload ?? {}) as Record<string, unknown>;
          const environmentId =
            typeof rawArgs.environmentId === "string" && rawArgs.environmentId.length > 0
              ? rawArgs.environmentId
              : local.environmentId;
          const args = { ...rawArgs, environmentId };
          const caller = { environmentId: local.environmentId, threadId: invocation.threadId };
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
          if (environmentId !== local.environmentId) {
            if (Option.isNone(relay)) {
              return Effect.succeed(
                toCallToolResult(
                  failure(
                    new Error(
                      `Environment ${environmentId} is not reachable from this chat. Open T3 Agents on a device connected to it.`,
                    ),
                    requestContext(args),
                  ),
                ),
              );
            }
            return relay.value.call({ environmentId, tool: name, args, caller }).pipe(
              Effect.map(toCallToolResult),
              Effect.catch((error) =>
                Effect.succeed(toCallToolResult(failure(error, requestContext(args)))),
              ),
            );
          }
          return Effect.promise(() => runGatewayTool(context, name, args, { caller })).pipe(
            Effect.map((run) => toCallToolResult(run.result)),
          );
        }),
    });
  }
});

/** Adds the T3 Agents tools to this server's `t3-code` MCP. */
export const AgentsToolsRegistrationLive = Layer.effectDiscard(registerAgentsTools);
