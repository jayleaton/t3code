import type * as Cause from "effect/Cause";
import {
  McpGatewayUnavailableError,
  type McpGatewayRelayEvent,
  type McpGatewayRelayResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

type Message = typeof Schema.JsonObject.Type;
const unavailable = (message: string) => new McpGatewayUnavailableError({ message });
interface Host {
  readonly owner: string;
  readonly connectionId: string;
  readonly requests: Queue.Queue<McpGatewayRelayEvent, Cause.Done>;
}
interface Session {
  readonly providerSessionId: string;
  readonly threadId: string;
  readonly host: Host;
  readonly notifications: Queue.Queue<Message, Cause.Done>;
  readonly pending: Map<string, Deferred.Deferred<Message, McpGatewayUnavailableError>>;
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hosts = new Map<string, Host>();
  const sessions = new Map<string, Session>();
  const close = Effect.fn("McpGatewayBroker.close")(function* (sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    for (const pending of session.pending.values()) {
      yield* Deferred.fail(
        pending,
        unavailable("The desktop gateway connection closed. Reconnect the MCP session."),
      );
    }
    yield* Queue.end(session.notifications);
    yield* Queue.offer(session.host.requests, {
      type: "close",
      connectionId: session.host.connectionId,
      sessionId,
    });
  });
  const closeThread = Effect.fn("McpGatewayBroker.closeThread")(function* (threadId: string) {
    for (const [id, session] of sessions) if (session.threadId === threadId) yield* close(id);
  });
  const closeAll = Effect.suspend(() =>
    Effect.forEach([...sessions.keys()], close, { discard: true }),
  );
  const connect = (owner: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const requests = yield* Queue.unbounded<McpGatewayRelayEvent, Cause.Done>();
        const host: Host = { owner, connectionId, requests };
        yield* Effect.acquireRelease(
          Effect.sync(() => hosts.set(connectionId, host)),
          () =>
            Effect.gen(function* () {
              hosts.delete(connectionId);
              for (const [id, session] of sessions) if (session.host === host) yield* close(id);
              yield* Queue.end(requests);
            }),
        );
        yield* Queue.offer(requests, { type: "connected", connectionId });
        return Stream.fromQueue(requests);
      }),
    );
  const open = Effect.fn("McpGatewayBroker.open")(function* (
    providerSessionId: string,
    threadId: string,
  ) {
    // Pin the session to one desktop; disconnects must not move it to another desktop's grants.
    const host = hosts.values().next().value;
    if (!host)
      return yield* Effect.fail(
        unavailable(
          "Enable MCP Gateway in a connected desktop before starting this agent session.",
        ),
      );
    const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const notifications = yield* Queue.unbounded<Message, Cause.Done>();
    sessions.set(sessionId, {
      providerSessionId,
      threadId,
      host,
      notifications,
      pending: new Map(),
    });
    return sessionId;
  });
  const lookup = (sessionId: string, providerSessionId: string) => {
    const session = sessions.get(sessionId);
    return session?.providerSessionId === providerSessionId ? session : undefined;
  };
  const send = Effect.fn("McpGatewayBroker.send")(function* (
    sessionId: string,
    providerSessionId: string,
    message: Message,
  ) {
    const session = lookup(sessionId, providerSessionId);
    if (!session)
      return yield* Effect.fail(unavailable("MCP gateway session is no longer available."));
    if (
      typeof message.method !== "string" ||
      (typeof message.id !== "string" && typeof message.id !== "number")
    ) {
      yield* Queue.offer(session.host.requests, {
        type: "message",
        connectionId: session.host.connectionId,
        sessionId,
        message,
      });
      return undefined;
    }
    const key = `${typeof message.id}:${message.id}`;
    if (session.pending.has(key))
      return yield* Effect.fail(unavailable("Duplicate MCP request ID."));
    const deferred = yield* Deferred.make<Message, McpGatewayUnavailableError>();
    session.pending.set(key, deferred);
    return yield* Effect.gen(function* () {
      yield* Queue.offer(session.host.requests, {
        type: "message",
        connectionId: session.host.connectionId,
        sessionId,
        message,
      });
      return yield* Deferred.await(deferred);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(
            unavailable("Desktop gateway request timed out; mutations were not replayed."),
          ),
      }),
      Effect.ensuring(Effect.sync(() => session.pending.delete(key))),
    );
  });
  const respond = Effect.fn("McpGatewayBroker.respond")(function* (
    owner: string,
    input: McpGatewayRelayResponse,
  ) {
    const session = sessions.get(input.sessionId);
    if (
      !session ||
      session.host.owner !== owner ||
      session.host.connectionId !== input.connectionId
    ) {
      return yield* Effect.fail(
        unavailable("Gateway response does not belong to this connection."),
      );
    }
    if (input.error !== undefined) {
      yield* close(input.sessionId);
      return;
    }
    const message = input.message;
    if (message === undefined) return;
    if (
      (typeof message.id === "string" || typeof message.id === "number") &&
      ("result" in message || "error" in message)
    ) {
      const pending = session.pending.get(`${typeof message.id}:${message.id}`);
      if (pending) yield* Deferred.succeed(pending, message);
    } else {
      yield* Queue.offer(session.notifications, message);
    }
  });
  return {
    connect,
    open,
    lookup,
    send,
    respond,
    close,
    closeThread,
    closeAll,
    available: () => hosts.size > 0,
  };
});

export class McpGatewayBroker extends Context.Service<
  McpGatewayBroker,
  Effect.Success<typeof make>
>()("t3/mcp/McpGatewayBroker") {}

let active: McpGatewayBroker["Service"] | undefined;
export const closeActiveGatewayThread = (threadId: string) =>
  active?.closeThread(threadId) ?? Effect.void;
export const closeAllActiveGatewaySessions = () => active?.closeAll ?? Effect.void;
export const activeGatewayAvailable = () => active?.available() ?? false;
export const layer = Layer.effect(
  McpGatewayBroker,
  Effect.gen(function* () {
    const broker = yield* make;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        active = broker;
      }),
      () =>
        Effect.sync(() => {
          if (active === broker) active = undefined;
        }),
    );
    return broker;
  }),
);
