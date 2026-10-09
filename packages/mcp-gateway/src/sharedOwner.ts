// @effect-diagnostics nodeBuiltinImport:off - the gateway is a plain Node process outside the Effect runtime.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The owner creates its state directory only after acquiring the bridge port.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Normalize the durable store identity across MCP launchers.
import * as NodePath from "node:path";
import type WebSocket from "ws";

import { createBridgeRuntimePort, type GatewayGrants } from "./bridge.ts";
import { startWebhookDeliveryWorker } from "./deliver.ts";
import { createGatewayEventStore, type GatewayEventStore } from "./events.ts";
import { hasGatewayScopes } from "./port.ts";
import { createMcpGateway } from "./server.ts";
import { acceptMcpSession, rejectRetiring, type GatewayBuild } from "./sharedTransport.ts";

export interface SharedGatewayConfig {
  readonly port: number;
  readonly token: string;
  readonly stateFile: string;
  readonly retentionEvents: number;
  readonly repositoryAllowlist: ReadonlyArray<string>;
  readonly initialGrants: GatewayGrants;
}

export function sharedGatewayConfiguration(config: SharedGatewayConfig): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        stateFile: NodePath.resolve(config.stateFile),
        retentionEvents: config.retentionEvents,
        repositoryAllowlist: [...config.repositoryAllowlist].sort(),
        initialGrants: Object.fromEntries(
          Object.entries(config.initialGrants)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([id, scopes]) => [id, [...scopes].sort()]),
        ),
      }),
    )
    .digest("hex");
}

function fileHash(file: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}

/** The running script's identity; it stops being current when the file on disk is replaced. */
export function gatewayBuild(entryPoint: string): GatewayBuild {
  const id = fileHash(entryPoint);
  return {
    id,
    isCurrent: () => {
      try {
        return fileHash(entryPoint) === id;
      } catch {
        return false;
      }
    },
  };
}

const UNKNOWN_BUILD: GatewayBuild = { id: "unknown", isCurrent: () => true };

/** One owner holds the runtime bridge, SQLite store and webhook worker for all MCP sessions. */
export async function startSharedGatewayOwner(
  config: SharedGatewayConfig,
  options: {
    readonly idleTimeoutMs?: number;
    readonly onIdle?: () => void;
    /** Launchers from a newer install retire this owner once its own script is replaced. */
    readonly build?: GatewayBuild;
  } = {},
) {
  const configuration = sharedGatewayConfiguration(config);
  const build = options.build ?? UNKNOWN_BUILD;
  const sessions = new Map<WebSocket, ReturnType<typeof createMcpGateway>>();
  const statusListeners = new Set<() => void>();
  let events: GatewayEventStore | undefined;
  let idleController: AbortController | undefined;
  let closing = false;
  const scheduleIdle = () => {
    idleController?.abort();
    if (options.onIdle === undefined || sessions.size > 0 || closing) return;
    const controller = new AbortController();
    idleController = controller;
    const timeout = AbortSignal.timeout(options.idleTimeoutMs ?? 30_000);
    timeout.addEventListener(
      "abort",
      () => {
        if (!controller.signal.aborted && sessions.size === 0 && !closing) options.onIdle?.();
      },
      { once: true },
    );
  };
  let unsubscribeStatus: (() => void) | undefined;
  let delivery: ReturnType<typeof startWebhookDeliveryWorker> | undefined;
  const close = async () => {
    if (closing) return;
    closing = true;
    idleController?.abort();
    unsubscribeStatus?.();
    await Promise.allSettled([
      delivery?.stop(),
      ...[...sessions.values()].map((gateway) => gateway.close()),
    ]);
    await bridge.close();
    events?.close();
  };
  const store = () => {
    if (events === undefined) throw new Error("Shared gateway store is not ready.");
    return events;
  };
  const bridge = createBridgeRuntimePort({
    port: config.port,
    token: config.token,
    initialGrants: config.initialGrants,
    getEventCursor: (id) => store().latestSequence(id),
    onEvent: (event) => store().ingest(event),
    getStatusSnapshot: (grants) => store().statusSnapshot(grants),
    onStatusChange: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    onMcpConnection: (socket) => {
      if (closing) {
        rejectRetiring(socket);
        return;
      }
      void acceptMcpSession(
        socket,
        config.token,
        configuration,
        build,
        async (transport) => {
          if (closing) throw new Error("Shared gateway is shutting down.");
          const gateway = createMcpGateway({
            port: bridge.port,
            grants: bridge.getGrants,
            profiles: bridge.getProfiles,
            repositoryAllowlist: config.repositoryAllowlist,
            events: store(),
            health: bridge.getHealth,
            waitForRuntime: bridge.waitForClient,
          });
          sessions.set(socket, gateway);
          idleController?.abort();
          socket.once("close", () => {
            sessions.delete(socket);
            void gateway.close().catch(() => undefined);
            scheduleIdle();
          });
          await gateway.connect(transport);
        },
        () => {
          // Sessions on the replaced build end; their hosts relaunch the installed script.
          void close();
        },
      ).catch(() => socket.terminate());
    },
  });
  const startup = await bridge.ready;
  if (startup.status === "degraded") {
    await bridge.close();
    if (startup.code === "address_in_use") return undefined;
    throw new Error(startup.message);
  }
  // Losing an owner-start race must not open SQLite or start another delivery worker.
  try {
    NodeFS.mkdirSync(NodePath.dirname(config.stateFile), { recursive: true, mode: 0o700 });
    events = createGatewayEventStore({
      file: config.stateFile,
      retentionEvents: config.retentionEvents,
    });
  } catch (error) {
    await bridge.close();
    throw error;
  }
  unsubscribeStatus = events.onStatusChange(() => {
    for (const listener of statusListeners) listener();
  });
  delivery = startWebhookDeliveryWorker(events, {
    isAuthorized: (id) => hasGatewayScopes(bridge.getGrants(), id, ["read", "delivery"]),
  });
  scheduleIdle();
  return { close };
}
