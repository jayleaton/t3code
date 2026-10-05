import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { McpGatewayRelayEvent, type McpGatewayRelayGrants } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { make } from "./McpGatewayBroker.ts";

type Broker = Effect.Success<typeof make>;

const failureMessage = <E extends { readonly message: string }>(
  effect: Effect.Effect<unknown, E>,
) => effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "ok" }));

/** Connects an app that answers every call with what `answer` returns for its method. */
const serve = (
  broker: Broker,
  owner: string,
  grants: McpGatewayRelayGrants,
  answer: (method: string, args: ReadonlyArray<unknown>) => { result?: unknown; error?: string },
) =>
  broker.connect(owner, grants).pipe(
    Stream.runForEach((event) =>
      broker.respond(owner, {
        connectionId: event.connectionId,
        invocationId: event.invocationId,
        ...answer(event.method, event.args),
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

it.effect("runs calls on the newest app that reaches every environment in them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      expect(broker.available()).toBe(false);
      yield* serve(broker, "laptop", { remote: ["read"] }, (method) => ({
        result: `laptop:${method}`,
      }));
      yield* serve(broker, "desktop", { remote: ["read", "send"], other: ["read"] }, (method) => ({
        result: `desktop:${method}`,
      }));
      expect(broker.available()).toBe(true);
      expect(broker.grants()).toEqual({ remote: ["read", "send"], other: ["read"] });
      expect(yield* broker.invoke("listProjects", ["remote"], ["remote"])).toBe(
        "desktop:listProjects",
      );
      expect(yield* broker.invoke("listThreads", ["other"], ["other"])).toBe("desktop:listThreads");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails calls no connected app can run, and reports app errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const none = yield* Effect.exit(broker.invoke("listProjects", ["remote"], ["remote"]));
      expect(Exit.isFailure(none)).toBe(true);
      yield* serve(broker, "desktop", { remote: ["read"] }, () => ({ error: "not granted" }));
      expect(yield* failureMessage(broker.invoke("listProjects", ["other"], ["other"]))).toContain(
        "other",
      );
      expect(yield* failureMessage(broker.invoke("listProjects", ["remote"], ["remote"]))).toBe(
        "not granted",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects answers from another app and fails calls when their app disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      const events = yield* broker
        .connect("desktop", { remote: ["read"] })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));
      const call = yield* broker
        .invoke("listProjects", ["remote"], ["remote"])
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const [event] = yield* Fiber.join(events);
      const spoofed = yield* Effect.exit(
        broker.respond("intruder", {
          connectionId: event!.connectionId,
          invocationId: event!.invocationId,
          result: "spoofed",
        }),
      );
      expect(Exit.isFailure(spoofed)).toBe(true);
      // The stream ended after one event, which disconnects its app.
      expect(yield* failureMessage(Fiber.join(call))).toContain("disconnected");
      expect(broker.available()).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("relays calls whose arguments hold undefined fields in a form the wire can encode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* make;
      // The relay RPC encodes each event as JSON; one unencodable event used to end the app's
      // whole relay stream, so every later call for its environments failed until a restart.
      const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(McpGatewayRelayEvent));
      const received: Array<ReadonlyArray<unknown>> = [];
      yield* broker.connect("desktop", { remote: ["read", "create"] }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* encode(event);
            received.push(event.args);
            yield* broker.respond("desktop", {
              connectionId: event.connectionId,
              invocationId: event.invocationId,
              result: event.method,
            });
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      // Profile sharing sends profiles whose optional model selection is undefined.
      const profiles = [{ name: "Builder", modelSelection: undefined, runtimeMode: "auto" }];
      expect(
        yield* broker.invoke("replicateProfiles", ["remote", profiles, undefined], ["remote"]),
      ).toBe("replicateProfiles");
      expect(yield* broker.invoke("listThreads", ["remote"], ["remote"])).toBe("listThreads");
      expect(received).toEqual([
        ["remote", [{ name: "Builder", runtimeMode: "auto" }]],
        ["remote"],
      ]);
      expect(broker.available()).toBe(true);
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(
        yield* failureMessage(broker.invoke("createSkill", ["remote", cyclic], ["remote"])),
      ).toContain("cannot be relayed");
      expect(broker.available()).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
