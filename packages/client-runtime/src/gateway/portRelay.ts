import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import { GATEWAY_PORT_METHODS, type GatewayGrants } from "./bridgeClient.ts";
import type { GatewayEnvironmentSummary, GatewayRuntimePort } from "./port.ts";
import { gatewayPortEnvironmentIds } from "./routedPort.ts";

/** Runs one relayed runtime port call if every environment it touches is granted. */
export async function answerGatewayPortCall(
  port: GatewayRuntimePort,
  granted: ReadonlySet<string>,
  method: string,
  args: ReadonlyArray<unknown>,
): Promise<unknown> {
  if (!GATEWAY_PORT_METHODS.has(method as keyof GatewayRuntimePort)) {
    throw new Error(`Unknown T3 Agents call ${method}.`);
  }
  if (method === "listEnvironments") {
    const environments = await port.listEnvironments();
    return environments.filter((environment: GatewayEnvironmentSummary) =>
      granted.has(environment.environmentId),
    );
  }
  const environmentIds = gatewayPortEnvironmentIds(args);
  const denied =
    environmentIds.length === 0 ? "this call" : environmentIds.find((id) => !granted.has(id));
  if (denied !== undefined) {
    throw new Error(`T3 Agents access is not granted for ${denied} on this device.`);
  }
  const run = port[method as keyof GatewayRuntimePort] as
    | ((...input: ReadonlyArray<unknown>) => Promise<unknown>)
    | undefined;
  if (run === undefined) throw new Error(`${method} is not available on this device.`);
  return run.call(port, ...args);
}

/**
 * Lets agents on each granted environment act on the other granted environments through this
 * app's connections. Each server runs the tools; this app only answers runtime port calls for
 * environments the user granted, and advertises those grants so the server can apply scopes.
 */
export function serveGatewayPortRelays<R>(
  context: Context.Context<EnvironmentRegistry | R>,
  port: GatewayRuntimePort,
  grants: GatewayGrants,
  onFailure: (error: unknown) => void,
) {
  const abort = new AbortController();
  const granted = new Set(Object.keys(grants));
  for (const id of granted) {
    const serve = Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      yield* registry
        .followStream(
          EnvironmentId.make(id),
          subscribeDynamicWithSession(WS_METHODS.mcpGatewayConnect, () =>
            Effect.succeed({ grants }),
          ),
        )
        .pipe(
          Stream.runForEach(([session, event]) =>
            Effect.sync(() => {
              // Calls run concurrently; a slow handoff must not hold up a listing.
              void answerGatewayPortCall(port, granted, event.method, event.args)
                .then(
                  (result) => ({ result }),
                  (error: unknown) => ({
                    error: error instanceof Error ? error.message : String(error),
                  }),
                )
                .then((outcome) =>
                  Effect.runPromise(
                    session.client[WS_METHODS.mcpGatewayRespond]({
                      connectionId: event.connectionId,
                      invocationId: event.invocationId,
                      ...outcome,
                    }),
                  ),
                )
                .catch((error) => {
                  if (!abort.signal.aborted) onFailure(error);
                });
            }),
          ),
        );
    });
    void Effect.runPromiseWith(context)(serve, { signal: abort.signal }).catch((error) => {
      if (!abort.signal.aborted) onFailure(error);
    });
  }
  return () => abort.abort();
}
