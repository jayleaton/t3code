import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";

/** A call between a task's owner and worker environments. Inputs are encoded contracts. */
export interface ThreadTaskRemoteRequest {
  readonly action: "remoteAssign" | "remoteDeliver" | "remoteOwnerAction" | "projectSnapshot";
  readonly input: unknown;
}

/**
 * Reaches another environment through a connected T3 app. The receiving server
 * authorizes each call by the task's capability, never by the app's session.
 */
export class ThreadTaskTransport extends Context.Service<
  ThreadTaskTransport,
  {
    readonly localEnvironmentId: EnvironmentId;
    /** Fails with a reason when no connected app reaches the environment. */
    readonly call: (
      environmentId: EnvironmentId,
      request: ThreadTaskRemoteRequest,
    ) => Effect.Effect<unknown, string>;
    /** Environments a connected app currently reaches. */
    readonly peers: () => ReadonlyArray<EnvironmentId>;
    /** Emits when a path to other environments may have opened. */
    readonly connected: Stream.Stream<void>;
  }
>()("t3/threadTask/ThreadTaskTransport") {}

export const layerFromBroker = Layer.effect(
  ThreadTaskTransport,
  Effect.gen(function* () {
    const broker = yield* McpGatewayBroker;
    const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    return ThreadTaskTransport.of({
      localEnvironmentId: descriptor.environmentId,
      call: (environmentId, request) =>
        broker
          .invoke("threadTask", [environmentId, request], [environmentId])
          .pipe(Effect.mapError((error) => error.message)),
      peers: () =>
        Object.keys(broker.grants())
          .filter((id) => id !== descriptor.environmentId)
          .map((id) => EnvironmentId.make(id)),
      connected: broker.hostConnected,
    });
  }),
);
