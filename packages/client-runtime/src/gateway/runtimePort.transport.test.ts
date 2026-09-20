import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Rpc, RpcClient, RpcGroup, RpcMessage } from "effect/unstable/rpc";
import { enrichGatewayRuntimeEventStream, loadGatewayEventSnapshot } from "./runtimePort.ts";
import { subscribe } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

it.effect("a paused gateway consumer does not block delivery of a replay frame", () =>
  Effect.gen(function* () {
    const method = ORCHESTRATION_WS_METHODS.subscribeEvents;
    const group = RpcGroup.make(
      Rpc.make(method, {
        payload: { afterSequence: Schema.Int },
        success: OrchestrationEvent,
        stream: true,
      }),
    );
    const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof group>>>();
    const { client, write } = yield* RpcClient.makeNoSerialization(group, {
      onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
    });
    const supervisor = {
      target: { environmentId: EnvironmentId.make("test") },
      session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
    } as EnvironmentSupervisor["Service"];
    const snapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 500,
      projects: [],
      threads: [],
      updatedAt: "2026-09-20T00:00:00.000Z",
    };
    const values = Array.from({ length: 500 }, (_, i) => ({
      eventId: `event-${i}`,
      sequence: i + 1,
      occurredAt: snapshot.updatedAt,
      type: "thread.meta-updated",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      correlationId: null,
      payload: { threadId: "thread-1", title: "Updated" },
    })) as unknown as [OrchestrationEvent, ...OrchestrationEvent[]];
    const entered = yield* Deferred.make<number>();
    const resume = yield* Deferred.make<void>();
    const consumer = yield* enrichGatewayRuntimeEventStream({
      environmentId: EnvironmentId.make("test"),
      machine: "MacBook",
      initialSnapshot: snapshot,
      events: subscribe(method, { afterSequence: 0 }, { streamBufferSize: 500 }),
      loadSnapshot: () => Effect.succeedNone,
    }).pipe(
      Stream.mapArrayEffect((batch) =>
        Deferred.succeed(entered, batch.length).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as(batch),
        ),
      ),
      Stream.take(500),
      Stream.runCollect,
      Effect.provideService(EnvironmentSupervisor, supervisor),
      Effect.forkScoped,
    );
    const request = yield* Queue.take(requests);
    if (request._tag !== "Request") throw new Error("Expected stream request");
    const delivery = yield* write({
      _tag: "Chunk",
      clientId: 0,
      requestId: request.id,
      values,
    }).pipe(Effect.forkScoped);
    const batchSize = yield* Deferred.await(entered);
    yield* TestClock.adjust(0);
    // The serialized socket reader can now process unrelated RPC replies and Pongs,
    // even if Chromium delays the downstream merge's next scheduled task.
    expect(delivery.pollUnsafe()).toBeDefined();
    expect(batchSize).toBe(500);
    yield* Deferred.succeed(resume, undefined);
    const events = yield* Fiber.join(consumer);
    expect(events.map((event) => event.sequence)).toEqual(values.map((event) => event.sequence));
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

for (const snapshotAvailable of [true, false]) {
  it.effect(
    `gateway enrichment drains replay with HTTP snapshot available: ${snapshotAvailable}`,
    () =>
      Effect.gen(function* () {
        const group = RpcGroup.make(
          Rpc.make("events", { success: OrchestrationEvent, stream: true }),
        );
        const requests =
          yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof group>>>();
        const { client, write } = yield* RpcClient.makeNoSerialization(group, {
          onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
        });
        const snapshot = {
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-09-20T00:00:00.000Z",
        } as OrchestrationShellSnapshot;
        const prepared = {} as PreparedConnection;
        const supervisor = {
          prepared: yield* SubscriptionRef.make(Option.some(prepared)),
        } as EnvironmentSupervisor["Service"];
        let refreshes = 0;
        const refreshed = { ...snapshot, snapshotSequence: 500 };
        const refresh = loadGatewayEventSnapshot.pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.provideService(ShellSnapshotLoader, {
            load: () =>
              Effect.sync(() => {
                refreshes++;
                return snapshotAvailable || refreshes > 1
                  ? Option.some({ ...refreshed, snapshotSequence: 501 })
                  : Option.none();
              }),
          }),
        );
        const consumer = yield* Stream.mergeAll(
          [
            enrichGatewayRuntimeEventStream({
              environmentId: EnvironmentId.make("test"),
              machine: "MacBook",
              initialSnapshot: snapshot,
              events: client.events(),
              loadSnapshot: () => refresh,
            }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Stream.take(snapshotAvailable ? 500 : 501), Stream.runCollect, Effect.forkScoped);
        const request = yield* Queue.take(requests);
        if (request._tag !== "Request") throw new Error("Expected stream request");
        const values = Array.from({ length: 500 }, (_, i) => ({
          eventId: `event-${i}`,
          sequence: i + 1,
          occurredAt: snapshot.updatedAt,
          type: "thread.meta-updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          correlationId: null,
          payload: { threadId: "thread-1", title: "Updated" },
        })) as unknown as OrchestrationEvent[];
        const delivery = yield* write({
          _tag: "Chunk",
          clientId: 0,
          requestId: request.id,
          values: values as [OrchestrationEvent, ...OrchestrationEvent[]],
        }).pipe(Effect.forkScoped);
        yield* Fiber.join(delivery);
        // The websocket reader cannot dispatch the snapshot response or a Pong until this completes.
        expect(delivery.pollUnsafe()).toBeDefined();
        expect(refreshes).toBe(1);
        if (!snapshotAvailable) {
          yield* TestClock.adjust("30 seconds");
          const next = { ...values[0]!, eventId: values[0]!.eventId, sequence: 501 };
          values.push(next);
          yield* write({ _tag: "Chunk", clientId: 0, requestId: request.id, values: [next] });
        }
        const events = yield* Fiber.join(consumer);
        expect(events).toHaveLength(snapshotAvailable ? 500 : 501);
        expect(refreshes).toBe(snapshotAvailable ? 1 : 2);
        expect(events.map((event) => event.sequence)).toEqual(
          values.map((event) => event.sequence),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
}
