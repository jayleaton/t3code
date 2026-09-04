import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createGatewayRuntimePortFromContext,
  gatewayEventFromOrchestration,
} from "./runtimePort.ts";

const environmentId = EnvironmentId.make("remote-1");
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

describe("Gateway Runtime Port", () => {
  it("redacts raw provider output and host paths before the bridge boundary", () => {
    const projected = gatewayEventFromOrchestration(environmentId, {
      eventId: "event-1",
      sequence: 4,
      occurredAt: "2026-09-04T00:00:00.000Z",
      type: "thread.activity-appended",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      correlationId: "corr-1",
      payload: {
        activity: {
          kind: "approval.requested",
          payload: {
            requestId: "approval-1",
            providerOutput: "secret output",
            hostPath: "/home/user/private",
            detail: "provider said secret output from /home/user/private",
          },
        },
      },
    } as never);

    expect(projected).toMatchObject({
      environmentId: "remote-1",
      type: "approval.requested",
      threadId: "thread-1",
      data: {
        serverSequence: 4,
        serverEventType: "thread.activity-appended",
        activityKind: "approval.requested",
        requestId: "approval-1",
      },
    });
    expect(projected.data).not.toHaveProperty("summary");
    expect(JSON.stringify(projected)).not.toContain("secret output");
    expect(JSON.stringify(projected)).not.toContain("/home/user/private");
  });

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
