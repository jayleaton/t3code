import * as Schema from "effect/Schema";

export class McpGatewayUnavailableError extends Schema.TaggedError<McpGatewayUnavailableError>()(
  "McpGatewayUnavailableError",
  { message: Schema.String },
) {}

/** Per-environment T3 Agents scopes a connected app grants to agents relayed through it. */
export const McpGatewayRelayGrants = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type McpGatewayRelayGrants = typeof McpGatewayRelayGrants.Type;

export const McpGatewayConnectInput = Schema.Struct({ grants: McpGatewayRelayGrants });
export type McpGatewayConnectInput = typeof McpGatewayConnectInput.Type;

/** A runtime port call an agent on this server needs a connected app to run on another environment. */
export const McpGatewayRelayEvent = Schema.Struct({
  type: Schema.Literal("invoke"),
  connectionId: Schema.String,
  invocationId: Schema.String,
  method: Schema.String,
  args: Schema.Array(Schema.Unknown),
});
export type McpGatewayRelayEvent = typeof McpGatewayRelayEvent.Type;

export const McpGatewayRelayResponse = Schema.Struct({
  connectionId: Schema.String,
  invocationId: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
export type McpGatewayRelayResponse = typeof McpGatewayRelayResponse.Type;
