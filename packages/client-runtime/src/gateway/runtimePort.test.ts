import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createGatewayRuntimePort, createGatewayRuntimePortFromContext } from "./runtimePort.ts";

const environmentId = EnvironmentId.make("remote-1");
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

describe("Gateway Runtime Port", () => {
  it.effect("projects the existing registry without starting or replacing it", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make(
        new Map([
          [
            environmentId,
            {
              target: {
                _tag: "RelayConnectionTarget" as const,
                environmentId,
                label: "Build machine",
              },
              profile: { _tag: "None" as const },
            },
          ],
        ]),
      );
      const start = vi.fn(() => Effect.void);
      const registry = EnvironmentRegistry.of({
        entries,
        start,
        state: () =>
          Effect.succeed({
            desired: true,
            network: "online",
            phase: "connected",
            stage: null,
            attempt: 1,
            generation: 1,
            lastFailure: null,
            retryAt: null,
          }),
      } as unknown as EnvironmentRegistry["Service"]);

      yield* Effect.gen(function* () {
        const context = yield* Effect.context<EnvironmentRegistry | Crypto.Crypto>();
        const port = createGatewayRuntimePortFromContext(context);
        const result = yield* Effect.promise(() => port.listEnvironments());

        expect(result).toEqual([
          {
            environmentId: "remote-1",
            label: "Build machine",
            targetKind: "relay",
            connectionState: "connected",
          },
        ]);
        expect(start).not.toHaveBeenCalled();
      }).pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provideService(Crypto.Crypto, testCrypto),
      );
    }),
  );
});

describe("opening a desktop chat", () => {
  it.each(["local", "remote"])(
    "validates the thread and awaits desktop navigation for %s",
    async (target) => {
      const navigation = Promise.withResolvers<void>();
      const open = vi.fn(() => navigation.promise);
      const runPromise = vi.fn(async () => ({ thread: { id: "chat", deletedAt: null } }));
      const port = createGatewayRuntimePort(
        { runPromise } as unknown as import("./runtimePort.ts").GatewayEffectRuntime,
        open,
      );
      let finished = false;
      const result = port.openThread(target, "chat").then((value) => {
        finished = true;
        return value;
      });
      await Promise.resolve();
      expect(runPromise).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith(target, "chat");
      expect(finished).toBe(false);
      navigation.resolve();
      await expect(result).resolves.toEqual({
        environmentId: target,
        threadId: "chat",
        status: "succeeded",
      });
    },
  );

  it.each([
    { id: "other", deletedAt: null },
    { id: "chat", deletedAt: "2026-09-01" },
  ])("rejects an unavailable thread", async (thread) => {
    const open = vi.fn(async () => {});
    const port = createGatewayRuntimePort(
      {
        runPromise: async () => ({ thread }),
      } as unknown as import("./runtimePort.ts").GatewayEffectRuntime,
      open,
    );
    await expect(port.openThread("remote", "chat")).rejects.toThrow("not found");
    expect(open).not.toHaveBeenCalled();
  });

  it("propagates connection failure without navigating", async () => {
    const open = vi.fn(async () => {});
    const port = createGatewayRuntimePort(
      {
        runPromise: async () => {
          throw new Error("offline");
        },
      },
      open,
    );
    await expect(port.openThread("remote", "chat")).rejects.toThrow("offline");
    expect(open).not.toHaveBeenCalled();
  });
});
