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

/**
 * Relayed args and results are arbitrary runtime port values, but the relay encodes them as
 * JSON and rejects `undefined` anywhere inside them. One optional field left `undefined` would
 * otherwise fail the app's whole relay stream. Drops it the way `JSON.stringify` does; throws
 * only for values JSON cannot carry at all, such as cycles or bigints.
 */
export function toMcpGatewayRelayJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
