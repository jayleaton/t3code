import type * as Cause from "effect/Cause";
import {
  McpGatewayUnavailableError,
  toMcpGatewayRelayJson,
  type McpGatewayRelayEvent,
  type McpGatewayRelayGrants,
  type McpGatewayRelayResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const unavailable = (message: string) => new McpGatewayUnavailableError({ message });

interface Host {
  readonly owner: string;
  readonly connectionId: string;
  readonly grants: McpGatewayRelayGrants;
  readonly requests: Queue.Queue<McpGatewayRelayEvent, Cause.Done>;
}
interface Pending {
  readonly host: Host;
  readonly deferred: Deferred.Deferred<unknown, McpGatewayUnavailableError>;
}

/**
 * Connected apps that run T3 Agents runtime port calls for this server's agents on the other
 * environments they reach. Each app advertises the grants its user set.
 */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hosts = new Map<string, Host>();
  const pending = new Map<string, Pending>();
  /** Fires when an app connects, so queued cross-environment work can retry at once. */
  const connected = yield* PubSub.unbounded<void>();
  const connect = (owner: string, grants: McpGatewayRelayGrants) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const requests = yield* Queue.unbounded<McpGatewayRelayEvent, Cause.Done>();
        const host: Host = { owner, connectionId, grants, requests };
        yield* Effect.acquireRelease(
          Effect.sync(() => hosts.set(connectionId, host)).pipe(
            Effect.andThen(PubSub.publish(connected, undefined)),
          ),
          () =>
            Effect.gen(function* () {
              hosts.delete(connectionId);
              for (const [id, call] of pending) {
                if (call.host !== host) continue;
                pending.delete(id);
                yield* Deferred.fail(
                  call.deferred,
                  unavailable("The T3 app relaying this call disconnected."),
                );
              }
              yield* Queue.end(requests);
            }),
        );
        return Stream.fromQueue(requests);
      }),
    );
  /** Union of every connected app's grants, per environment. */
  const grants = (): Record<string, ReadonlyArray<string>> => {
    const merged: Record<string, Set<string>> = {};
    for (const host of hosts.values()) {
      for (const [environmentId, scopes] of Object.entries(host.grants)) {
        const into = (merged[environmentId] ??= new Set());
        for (const scope of scopes) into.add(scope);
      }
    }
    return Object.fromEntries(Object.entries(merged).map(([id, scopes]) => [id, [...scopes]]));
  };
  const invoke = Effect.fn("McpGatewayBroker.invoke")(function* (
    method: string,
    args: ReadonlyArray<unknown>,
    environmentIds: ReadonlyArray<string>,
  ): Effect.fn.Return<unknown, McpGatewayUnavailableError> {
    // The newest app that reaches every environment in the call runs it.
    const host = [...hosts.values()]
      .toReversed()
      .find((candidate) => environmentIds.every((id) => candidate.grants[id] !== undefined));
    if (!host) {
      return yield* Effect.fail(
        unavailable(
          hosts.size === 0
            ? "No T3 app with T3 Agents enabled is connected to this environment."
            : `No connected T3 app grants T3 Agents access to ${environmentIds.join(", ")}.`,
        ),
      );
    }
    // Omitted trailing arguments stay omitted rather than arriving as null.
    const sent = args.slice(0, args.findLastIndex((arg) => arg !== undefined) + 1);
    const relayedArgs = yield* Effect.try({
      try: () => toMcpGatewayRelayJson(sent) as ReadonlyArray<unknown>,
      catch: () => unavailable(`The arguments of ${method} cannot be relayed to a T3 app.`),
    });
    const invocationId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const deferred = yield* Deferred.make<unknown, McpGatewayUnavailableError>();
    pending.set(invocationId, { host, deferred });
    return yield* Effect.gen(function* () {
      yield* Queue.offer(host.requests, {
        type: "invoke",
        connectionId: host.connectionId,
        invocationId,
        method,
        args: relayedArgs,
      });
      return yield* Deferred.await(deferred);
    }).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () =>
          Effect.fail(unavailable("The T3 app relaying this call timed out; it was not retried.")),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(invocationId))),
    );
  });
  const respond = Effect.fn("McpGatewayBroker.respond")(function* (
    owner: string,
    input: McpGatewayRelayResponse,
  ) {
    const call = pending.get(input.invocationId);
    if (!call || call.host.owner !== owner || call.host.connectionId !== input.connectionId) {
      return yield* Effect.fail(unavailable("Relay response does not belong to this connection."));
    }
    pending.delete(input.invocationId);
    if (input.error !== undefined) {
      yield* Deferred.fail(call.deferred, unavailable(input.error));
      return;
    }
    yield* Deferred.succeed(call.deferred, input.result);
  });
  return {
    connect,
    grants,
    invoke,
    respond,
    available: () => hosts.size > 0,
    hostConnected: Stream.fromPubSub(connected),
  };
});

export class McpGatewayBroker extends Context.Service<
  McpGatewayBroker,
  Effect.Success<typeof make>
>()("t3/mcp/McpGatewayBroker") {}

export const layer = Layer.effect(McpGatewayBroker, make);
