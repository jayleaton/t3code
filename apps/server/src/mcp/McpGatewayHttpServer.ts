import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { McpGatewayBroker } from "./McpGatewayBroker.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";

/** Provider-local HTTP transport; the desktop retains the stdio session and gateway credential. */
export const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry;
  const broker = yield* McpGatewayBroker;
  const bearer = request.headers.authorization;
  const scope = yield* registry.resolve(bearer?.startsWith("Bearer ") ? bearer.slice(7) : "");
  if (!scope) return HttpServerResponse.empty({ status: 401 });
  if (!scope.capabilities.has("gateway")) return HttpServerResponse.empty({ status: 403 });
  let sessionId = request.headers["mcp-session-id"];
  if (request.method === "POST") {
    const message = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.JsonObject)),
    );
    if (message.jsonrpc !== "2.0") return HttpServerResponse.empty({ status: 400 });
    const initializing = message.method === "initialize";
    if (initializing) {
      if (sessionId !== undefined) return HttpServerResponse.empty({ status: 400 });
      sessionId = yield* broker.open(scope.providerSessionId, scope.threadId);
    }
    if (!sessionId || !broker.lookup(sessionId, scope.providerSessionId))
      return HttpServerResponse.empty({ status: 404 });
    const id = sessionId;
    const result = yield* broker
      .send(id, scope.providerSessionId, message)
      .pipe(Effect.onError(() => (initializing ? broker.close(id) : Effect.void)));
    if (result === undefined) return HttpServerResponse.empty({ status: 202 });
    return HttpServerResponse.jsonUnsafe(result, {
      headers: { "mcp-session-id": id, "cache-control": "no-store" },
    });
  }
  if (!sessionId) return HttpServerResponse.empty({ status: 400 });
  const session = broker.lookup(sessionId, scope.providerSessionId);
  if (!session) return HttpServerResponse.empty({ status: 404 });
  if (request.method === "DELETE") {
    yield* broker.close(sessionId);
    return HttpServerResponse.empty({ status: 202 });
  }
  if (request.method === "GET") {
    const encode = new TextEncoder();
    return HttpServerResponse.stream(
      Stream.concat(
        Stream.make(encode.encode(": connected\n\n")),
        Stream.fromQueue(session.notifications).pipe(
          Stream.map((message) =>
            encode.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`),
          ),
        ),
      ),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
    );
  }
  return HttpServerResponse.empty({ status: 405 });
}).pipe(
  Effect.catchTag("McpGatewayUnavailableError", (error) =>
    Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 503 })),
  ),
  Effect.catchTag("SchemaError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry;
    const broker = yield* McpGatewayBroker;
    const route = handler.pipe(
      Effect.provideService(McpSessionRegistry, registry),
      Effect.provideService(McpGatewayBroker, broker),
    );
    return Layer.mergeAll(
      HttpRouter.add("POST", "/mcp/gateway", route),
      HttpRouter.add("GET", "/mcp/gateway", route),
      HttpRouter.add("DELETE", "/mcp/gateway", route),
    );
  }),
);
