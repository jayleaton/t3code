import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as McpGatewayBrokerModule from "../mcp/McpGatewayBroker.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";
import { layerFromBroker, RemoteParentSettlement } from "./RemoteParentSettlement.ts";

const pc = EnvironmentId.make("environment-pc");
const laptop = EnvironmentId.make("environment-laptop");
const settledAt = "2026-10-22T09:00:00.000Z";

/** Threads as each machine's relaying app reports them from getThread. */
const threads: Record<string, Record<string, unknown>> = {
  [`${pc}:manual-card`]: { settledAt, settlementSource: "manual", parentThreadId: null },
  // Aged out under a card settled by hand on yet another machine.
  [`${pc}:aged-child`]: {
    settledAt: "2026-10-21T00:00:00.000Z",
    settlementSource: "inactivity",
    parentThreadId: "laptop-card",
    parentEnvironmentId: laptop,
  },
  [`${laptop}:laptop-card`]: { settledAt, settlementSource: "manual", parentThreadId: null },
  [`${pc}:aged-card`]: { settledAt, settlementSource: "inactivity", parentThreadId: null },
  [`${pc}:active-card`]: { settledAt: null, parentThreadId: null },
  // An environment or app from before settlementSource was reported.
  [`${pc}:old-card`]: { settledAt, parentThreadId: null },
};

const layer = Layer.effect(
  McpGatewayBroker,
  Effect.gen(function* () {
    const broker = yield* McpGatewayBrokerModule.make;
    yield* broker.connect("desktop", { [pc]: ["read"], [laptop]: ["read"] }).pipe(
      Stream.runForEach((event) =>
        broker.respond("desktop", {
          connectionId: event.connectionId,
          invocationId: event.invocationId,
          result: threads[`${String(event.args[0])}:${String(event.args[1])}`] ?? null,
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return broker;
  }),
).pipe(Layer.provide(NodeServices.layer));

it.effect("reads how a parent on another machine settled, past ancestors that aged out", () =>
  Effect.gen(function* () {
    const remote = yield* RemoteParentSettlement;
    const read = (environmentId: EnvironmentId, threadId: string) =>
      remote
        .manualSettledAt(environmentId, ThreadId.make(threadId))
        .pipe(Effect.map((at) => (at === null ? null : DateTime.formatIso(at))));
    expect(yield* read(pc, "manual-card")).toBe(settledAt);
    expect(yield* read(pc, "aged-child")).toBe(settledAt);
    expect(yield* read(pc, "aged-card")).toBeNull();
    expect(yield* read(pc, "active-card")).toBeNull();
    expect(yield* read(pc, "old-card")).toBeNull();
    // No connected app grants this machine.
    expect(yield* read(EnvironmentId.make("environment-unknown"), "manual-card")).toBeNull();
  }).pipe(Effect.provide(layerFromBroker.pipe(Layer.provideMerge(layer)))),
);
