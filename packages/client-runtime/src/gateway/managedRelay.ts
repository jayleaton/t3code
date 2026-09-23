import { EnvironmentId, WS_METHODS, type DesktopBridge } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

/** Carries MCP traffic over the same authenticated connections as the desktop runtime. */
export function connectManagedGatewayRelays<R>(
  context: Context.Context<EnvironmentRegistry | R>,
  bridge: DesktopBridge,
  environmentIds: ReadonlyArray<string>,
  onFailure: (error: unknown) => void,
) {
  const sessions = new Map<
    string,
    {
      session: RpcSession;
      connectionId: string;
      sessionId: string;
    }
  >();
  const abort = new AbortController();
  const unsubscribe = bridge.onManagedMcpGatewayEvent?.((event) => {
    if (event.sessionId === "" && event.error) {
      onFailure(new Error(event.error));
      abort.abort();
      return;
    }
    const route = sessions.get(event.sessionId);
    if (!route) return;
    void Effect.runPromise(
      route.session.client[WS_METHODS.mcpGatewayRespond]({
        connectionId: route.connectionId,
        sessionId: route.sessionId,
        ...(event.message ? { message: event.message } : {}),
        ...(event.error ? { error: event.error } : {}),
      }),
    ).catch((error) => {
      if (!abort.signal.aborted) onFailure(error);
    });
  });
  for (const id of environmentIds) {
    const owned = new Set<string>();
    let activeConnectionId: string | undefined;
    const closeOwned = async () => {
      const previous = [...owned];
      owned.clear();
      await Promise.all(
        previous.map(async (key) => {
          sessions.delete(key);
          await bridge.closeManagedMcpGatewaySession?.(key);
        }),
      );
    };
    const consume = Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry;
      yield* registry
        .followStream(
          EnvironmentId.make(id),
          subscribeDynamicWithSession(WS_METHODS.mcpGatewayConnect, () => Effect.succeed({})),
        )
        .pipe(
          Stream.runForEach(([session, event]) =>
            Effect.promise(async () => {
              if (event.type === "connected") {
                await closeOwned();
                activeConnectionId = event.connectionId;
                return;
              }
              if (event.connectionId !== activeConnectionId) return;
              const key = `${event.connectionId}:${event.sessionId}`;
              if (event.type === "close") {
                sessions.delete(key);
                owned.delete(key);
                await bridge.closeManagedMcpGatewaySession?.(key);
                return;
              }
              sessions.set(key, {
                session,
                connectionId: event.connectionId,
                sessionId: event.sessionId,
              });
              owned.add(key);
              try {
                await bridge.sendManagedMcpGatewayMessage?.({
                  sessionId: key,
                  message: event.message,
                });
              } catch {
                await Effect.runPromise(
                  session.client[WS_METHODS.mcpGatewayRespond]({
                    connectionId: event.connectionId,
                    sessionId: event.sessionId,
                    error: "Desktop gateway transport failed.",
                  }),
                );
              }
            }),
          ),
          Effect.ensuring(Effect.promise(closeOwned)),
        );
    });
    void Effect.runPromiseWith(context)(consume, { signal: abort.signal }).catch((error) => {
      if (!abort.signal.aborted) onFailure(error);
    });
  }
  return () => {
    unsubscribe?.();
    abort.abort();
  };
}
