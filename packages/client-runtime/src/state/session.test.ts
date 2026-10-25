import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  sessionGrantsScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("session-environment"),
  label: "Session environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

// The supervisor publishes a fresh object for each attempt stage, so each one
// refetches the session.
const prepared = (): PreparedConnection => ({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: `${TARGET.wsBaseUrl}/ws`,
  httpAuthorization: { _tag: "Bearer", token: "token" },
  target: TARGET,
});

const SESSION = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  scopes: ["orchestration:read", "orchestration:operate"],
  permissions: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "bearer-access-token",
} satisfies typeof AuthSessionState.Encoded;

const makeHarness = Effect.fn("SessionStateTest.makeHarness")(function* () {
  const failNext: Array<boolean> = [];
  const requests = yield* Queue.unbounded<void>();
  const httpClient = HttpClient.make((request) =>
    Queue.offer(requests, undefined).pipe(
      Effect.andThen(
        failNext.shift() === true
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "offline" }),
              }),
            )
          : Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(SESSION))),
      ),
    ),
  );
  const preparedRef = yield* SubscriptionRef.make(Option.some(prepared()));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
    prepared: preparedRef,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(HttpClient.HttpClient, httpClient),
    ),
  );
  const atom = createEnvironmentSessionAtoms(runtime).sessionStateAtom(TARGET.environmentId);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => registry.mount(atom)),
    (unmount) => Effect.sync(unmount),
  );
  const settled = AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter((result) => !result.waiting && result._tag !== "Initial"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  return { failNext, preparedRef, requests, settled };
});

it.effect("a session fetch that fails while connected is retried instead of denying scopes", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Queue.take(harness.requests);
    expect(AsyncResult.isSuccess(yield* harness.settled)).toBe(true);

    // The socket comes up moments after the first fetch, so the previous
    // success is still fresh when this one drops.
    harness.failNext.push(true);
    yield* SubscriptionRef.set(harness.preparedRef, Option.some(prepared()));
    yield* Queue.take(harness.requests);
    yield* TestClock.adjust("1 second");

    const result = yield* harness.settled;
    const session = Option.getOrThrow(AsyncResult.value(result));
    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(sessionGrantsScope(session, AuthOrchestrationOperateScope)).toBe(true);
  }).pipe(Effect.scoped),
);
