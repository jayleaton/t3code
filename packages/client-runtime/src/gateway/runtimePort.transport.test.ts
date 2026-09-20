import { EnvironmentId, OrchestrationEvent, OrchestrationShellSnapshot } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
        const refreshed = { ...snapshot, snapshotSequence: 64 };
        const refresh = loadGatewayEventSnapshot.pipe(
          Effect.provideService(EnvironmentSupervisor, supervisor),
          Effect.provideService(ShellSnapshotLoader, {
            load: () =>
              Effect.sync(() => {
                refreshes++;
                return snapshotAvailable || refreshes > 1
                  ? Option.some({ ...refreshed, snapshotSequence: 65 })
                  : Option.none();
              }),
          }),
        );
        const consumer = yield* enrichGatewayRuntimeEventStream({
          environmentId: EnvironmentId.make("test"),
          machine: "MacBook",
          initialSnapshot: snapshot,
          events: client.events(),
          loadSnapshot: () => refresh,
        }).pipe(Stream.take(snapshotAvailable ? 64 : 65), Stream.runCollect, Effect.forkScoped);
        const request = yield* Queue.take(requests);
        if (request._tag !== "Request") throw new Error("Expected stream request");
        const values = Array.from({ length: 64 }, (_, i) => ({
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
        yield* TestClock.adjust(0);
        // The websocket reader cannot dispatch the snapshot response or a Pong until this completes.
        expect(delivery.pollUnsafe()).toBeDefined();
        expect(refreshes).toBe(1);
        if (!snapshotAvailable) {
          yield* TestClock.adjust("30 seconds");
          const next = { ...values[0]!, eventId: values[0]!.eventId, sequence: 65 };
          values.push(next);
          yield* write({ _tag: "Chunk", clientId: 0, requestId: request.id, values: [next] });
        }
        const events = yield* Fiber.join(consumer);
        expect(events).toHaveLength(snapshotAvailable ? 64 : 65);
        expect(refreshes).toBe(snapshotAvailable ? 1 : 2);
        expect(events.map((event) => event.sequence)).toEqual(
          values.map((event) => event.sequence),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
}
