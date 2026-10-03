import * as Schema from "effect/Schema";

export class McpGatewayUnavailableError extends Schema.TaggedError<McpGatewayUnavailableError>()(
  "McpGatewayUnavailableError",
  { message: Schema.String },
) {}

export const McpGatewayRelayEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("message"),
    connectionId: Schema.String,
    sessionId: Schema.String,
    message: Schema.JsonObject,
  }),
  Schema.Struct({
    type: Schema.Literal("close"),
    connectionId: Schema.String,
    sessionId: Schema.String,
  }),
]);
export type McpGatewayRelayEvent = typeof McpGatewayRelayEvent.Type;

export const McpGatewayRelayResponse = Schema.Struct({
  connectionId: Schema.String,
  sessionId: Schema.String,
  message: Schema.optionalKey(Schema.JsonObject),
  error: Schema.optionalKey(Schema.String),
});
export type McpGatewayRelayResponse = typeof McpGatewayRelayResponse.Type;

export const McpGatewayDesktopMessage = Schema.Struct({
  sessionId: Schema.String,
  message: Schema.JsonObject,
});
export type McpGatewayDesktopMessage = typeof McpGatewayDesktopMessage.Type;

export const McpGatewayDesktopEvent = Schema.Struct({
  sessionId: Schema.String,
  message: Schema.optionalKey(Schema.JsonObject),
  error: Schema.optionalKey(Schema.String),
});
export type McpGatewayDesktopEvent = typeof McpGatewayDesktopEvent.Type;
