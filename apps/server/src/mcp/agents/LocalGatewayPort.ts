import {
  AuthSessionId,
  AuthStandardClientScopes,
  type EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionCatalogEntry,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  createGatewayRuntimePortFromContext,
  type GatewayRuntimePort,
} from "@t3tools/client-runtime/gateway";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcTest } from "effect/rpc";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeInProcessWsRpcLayer } from "../../ws.ts";

/**
 * The T3 Agents gateway tools for this environment, run against the server's own
 * WebSocket RPC API through an in-memory client. Tools behave exactly as they do for a
 * remote client, because they use the same runtime port and the same RPC handlers.
 */
export class LocalGatewayPort extends Context.Service<
  LocalGatewayPort,
  {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly port: GatewayRuntimePort;
  }
>()("t3/mcp/agents/LocalGatewayPort") {}

// Agents act like a normally paired client: orchestration, terminals and reviews, but no
// access or relay administration.
const session: AuthenticatedSession = {
  sessionId: AuthSessionId.make("t3-agents-mcp"),
  subject: "t3-agents-mcp",
  method: "bearer-access-token",
  scopes: AuthStandardClientScopes,
};

export const layer = Layer.effect(
  LocalGatewayPort,
  Effect.gen(function* () {
    const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    const environmentId = descriptor.environmentId;
    const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
      Effect.provide(makeInProcessWsRpcLayer(session)),
    );
    const rpcSession = {
      client,
      initialConfig: client[WS_METHODS.serverGetConfig]({}).pipe(Effect.orDie),
    };
    // The runtime port reads only these registry and supervisor members, and only for this
    // environment: it is always connected, through the in-memory client.
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: descriptor.label,
      httpBaseUrl: "",
      wsBaseUrl: "",
    });
    const supervisor = {
      target,
      session: yield* SubscriptionRef.make(Option.some(rpcSession)),
    } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
    const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
    const unavailable = (id: EnvironmentId) =>
      new EnvironmentRpcUnavailableError({
        environmentId: id,
        message: "This server only runs tools for its own environment.",
      });
    const registry = {
      entries: yield* SubscriptionRef.make(new Map([[environmentId, entry]])),
      state: (id: EnvironmentId) =>
        id === environmentId
          ? Effect.succeed({ ...AVAILABLE_CONNECTION_STATE, desired: true, phase: "connected" })
          : Effect.fail(unavailable(id)),
      run: <A, E>(
        id: EnvironmentId,
        effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) =>
        id === environmentId
          ? effect.pipe(
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            )
          : Effect.fail(unavailable(id)),
      runStream: <A, E>(
        id: EnvironmentId,
        stream: Stream.Stream<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) =>
        id === environmentId
          ? stream.pipe(
              Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            )
          : Stream.fail(unavailable(id)),
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
    const context = Context.make(EnvironmentRegistry.EnvironmentRegistry, registry).pipe(
      Context.add(Crypto.Crypto, yield* Crypto.Crypto),
    );
    return LocalGatewayPort.of({
      environmentId,
      label: descriptor.label,
      port: createGatewayRuntimePortFromContext(context),
    });
  }),
);
