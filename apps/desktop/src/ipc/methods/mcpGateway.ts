import { McpGatewayDesktopMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ManagedMcpGateway } from "../../ManagedMcpGateway.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

export const configureManagedMcpGateway = DesktopIpc.makeIpcMethod({
  channel: Channels.CONFIGURE_MANAGED_MCP_GATEWAY_CHANNEL,
  payload: Schema.NullOr(
    Schema.Struct({
      token: Schema.String,
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.mcpGateway.configure")(function* (input, event) {
    const gateway = yield* ManagedMcpGateway;
    yield* gateway.configure(event?.sender.id ?? -1, input);
  }),
});
export const sendManagedMcpGatewayMessage = DesktopIpc.makeIpcMethod({
  channel: Channels.SEND_MANAGED_MCP_GATEWAY_MESSAGE_CHANNEL,
  payload: McpGatewayDesktopMessage,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.mcpGateway.send")(function* (input, event) {
    const gateway = yield* ManagedMcpGateway;
    yield* gateway.send(event?.sender.id ?? -1, input.sessionId, input.message);
  }),
});
export const closeManagedMcpGatewaySession = DesktopIpc.makeIpcMethod({
  channel: Channels.CLOSE_MANAGED_MCP_GATEWAY_SESSION_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.mcpGateway.closeSession")(function* (sessionId, event) {
    const gateway = yield* ManagedMcpGateway;
    yield* gateway.closeSession(event?.sender.id ?? -1, sessionId);
  }),
});
