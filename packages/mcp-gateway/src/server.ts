import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { failure, requestContext, runGatewayTool, TOOL_SPECS } from "./catalog.ts";
import type { GatewayRuntimePort } from "./port.ts";
import {
  type GatewayGrantSource,
  type GatewayProfileSource,
  type GatewayToolContext,
} from "./tools.ts";

export function createMcpGateway(input: {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
  readonly repositoryAllowlist?: ReadonlyArray<string>;
  readonly events?: import("./events.ts").GatewayEventStore;
  readonly health?: GatewayToolContext["health"];
  /** Holds calls while the desktop runtime is (re)connecting, so grants are not read too early. */
  readonly waitForRuntime?: () => Promise<void>;
}) {
  const server = new McpServer({ name: "t3-code", version: "3.0.0" });
  const context: GatewayToolContext = {
    port: input.port,
    grants: input.grants,
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
    ...(input.repositoryAllowlist === undefined
      ? {}
      : { repositoryAllowlist: input.repositoryAllowlist }),
    ...(input.events === undefined ? {} : { events: input.events }),
    ...(input.health === undefined ? {} : { health: input.health }),
  };

  const hasScope = (environmentId: string, scope: "read" | "delivery") => {
    const grants = typeof input.grants === "function" ? input.grants() : input.grants;
    return grants[environmentId]?.includes(scope) === true;
  };
  const activeSubscriptions = new Set<string>();
  const initializingSubscriptions = new Set<string>();
  const bufferedEvents = new Map<string, Array<import("./events.ts").GatewayEvent>>();
  const deliveryChains = new Map<string, Promise<void>>();
  const forwardedSequences = new Map<string, number>();
  const notify = async (subscriptionId: string, event: import("./events.ts").GatewayEvent) => {
    if (!hasScope(event.environmentId, "read")) return;
    await server.server.notification({
      method: "notifications/t3/events",
      params: { schemaVersion: "3", subscriptionId, event },
    } as never);
    forwardedSequences.set(
      subscriptionId,
      Math.max(forwardedSequences.get(subscriptionId) ?? 0, event.sequence),
    );
  };
  const enqueue = (subscriptionId: string, event: import("./events.ts").GatewayEvent) => {
    const previous = deliveryChains.get(subscriptionId) ?? Promise.resolve();
    const next = previous.then(() => notify(subscriptionId, event));
    deliveryChains.set(
      subscriptionId,
      next.catch(() => undefined),
    );
    return next;
  };
  const enqueueCatchUp = (subscriptionId: string) => {
    const previous = deliveryChains.get(subscriptionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (input.events === undefined) return;
      const subscription = input.events.subscriptionById(subscriptionId);
      if (subscription === undefined || !hasScope(subscription.environmentId, "read")) return;
      let afterSequence = Math.max(
        subscription.ackedSequence,
        forwardedSequences.get(subscriptionId) ?? 0,
      );
      for (;;) {
        const replay = input.events.history(
          subscription.environmentId,
          afterSequence,
          500,
          subscription.types,
        );
        for (const event of replay) {
          await notify(subscriptionId, event);
          afterSequence = event.sequence;
        }
        if (replay.length < 500) break;
      }
    });
    deliveryChains.set(
      subscriptionId,
      next.catch(() => undefined),
    );
    return next;
  };
  const activateSubscription = async (subscriptionId: string) => {
    if (input.events === undefined) return;
    const subscription = input.events.subscriptionById(subscriptionId);
    if (subscription === undefined) return;
    const delivered = new Set<string>();
    initializingSubscriptions.add(subscriptionId);
    bufferedEvents.set(subscriptionId, []);
    try {
      let afterSequence = subscription.ackedSequence;
      for (;;) {
        const replay = input.events.history(
          subscription.environmentId,
          afterSequence,
          500,
          subscription.types,
        );
        for (const event of replay) {
          delivered.add(event.eventId);
          await enqueue(subscriptionId, event);
          afterSequence = event.sequence;
        }
        if (replay.length < 500) break;
      }
      for (;;) {
        const buffered = bufferedEvents.get(subscriptionId) ?? [];
        if (buffered.length === 0) break;
        bufferedEvents.set(subscriptionId, []);
        for (const event of buffered.toSorted((left, right) => left.sequence - right.sequence)) {
          if (delivered.has(event.eventId)) continue;
          delivered.add(event.eventId);
          await enqueue(subscriptionId, event);
        }
      }
      activeSubscriptions.add(subscriptionId);
    } finally {
      initializingSubscriptions.delete(subscriptionId);
      bufferedEvents.delete(subscriptionId);
    }
  };
  const unsubscribe = input.events?.onEvent((event) => {
    for (const subscriptionId of input.events?.matchingSubscriptions(event) ?? []) {
      if (!hasScope(event.environmentId, "read")) {
        input.events?.ack(subscriptionId, event.sequence);
        forwardedSequences.set(subscriptionId, event.sequence);
        continue;
      }
      if (initializingSubscriptions.has(subscriptionId)) {
        const pending = bufferedEvents.get(subscriptionId) ?? [];
        pending.push(event);
        bufferedEvents.set(subscriptionId, pending);
      } else if (activeSubscriptions.has(subscriptionId)) {
        void enqueueCatchUp(subscriptionId).catch(() => undefined);
      }
    }
  });

  for (const [name, [description, inputSchema]] of Object.entries(TOOL_SPECS)) {
    server.registerTool(
      name,
      { description, inputSchema: z.strictObject(inputSchema) },
      async (rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        if (name !== "t3_get_gateway_health") {
          try {
            await input.waitForRuntime?.();
          } catch (error) {
            return failure(error, requestContext(args));
          }
        }
        const run = await runGatewayTool(context, name, args, {});
        if (
          run.ok &&
          (name === "t3_subscribe_events" || name === "t3_replay_events") &&
          input.events !== undefined
        ) {
          await activateSubscription((run.value as { subscriptionId: string }).subscriptionId);
        }
        return run.result;
      },
    );
  }

  return {
    server,
    connect: (transport: Transport) => server.connect(transport),
    close: async () => {
      unsubscribe?.();
      await server.close();
    },
  };
}
