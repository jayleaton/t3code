import { McpGatewayUnavailableError } from "@t3tools/contracts";
import { createManagedGatewayHost } from "@t3tools/mcp-gateway/managedHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Electron from "electron";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import { resolveMcpGatewayLaunchConfig } from "./mcpGatewayLaunchConfig.ts";
import { MANAGED_MCP_GATEWAY_EVENT_CHANNEL } from "./ipc/channels.ts";

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const hosts = new Map<number, Awaited<ReturnType<typeof createManagedGatewayHost>>>();
  const unwatch = new Map<number, () => void>();
  const lock = yield* Semaphore.make(1);
  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new McpGatewayUnavailableError({
          message: `Desktop MCP gateway failed: ${cause instanceof Error ? cause.message : "unknown transport error"}`,
        }),
    });
  const close = async (ownerId: number) => {
    const host = hosts.get(ownerId);
    hosts.delete(ownerId);
    unwatch.get(ownerId)?.();
    unwatch.delete(ownerId);
    await host?.close();
  };
  yield* Effect.addFinalizer(() =>
    attempt(async () => {
      await Promise.all([...hosts.keys()].map(close));
    }).pipe(Effect.ignore),
  );
  return {
    configure: (ownerId: number, input: { readonly token: string; readonly port: number } | null) =>
      lock.withPermit(
        attempt(async () => {
          await close(ownerId);
          if (input === null) return;
          const launch = resolveMcpGatewayLaunchConfig({
            isPackaged: environment.isPackaged,
            executablePath: process.execPath,
            resourcesPath: environment.resourcesPath,
            stateFile: environment.path.join(environment.baseDir, "mcp-gateway-v3.sqlite"),
          });
          if (launch === null || input.token.length < 16) throw new Error("Gateway unavailable.");
          const sender = Electron.webContents.fromId(ownerId);
          if (!sender || sender.isDestroyed()) throw new Error("Gateway window closed.");
          const host = await createManagedGatewayHost(
            {
              ...launch,
              env: {
                ...launch.env,
                T3_MCP_BRIDGE_TOKEN: input.token,
                T3_MCP_BRIDGE_PORT: String(input.port),
              },
            },
            (event) => {
              if (!sender.isDestroyed()) sender.send(MANAGED_MCP_GATEWAY_EVENT_CHANNEL, event);
            },
          );
          if (sender.isDestroyed()) {
            await host.close();
            return;
          }
          hosts.set(ownerId, host);
          const onDestroyed = () => {
            void close(ownerId).catch(() => undefined);
          };
          sender.once("destroyed", onDestroyed);
          unwatch.set(ownerId, () => sender.removeListener("destroyed", onDestroyed));
        }),
      ),
    send: (ownerId: number, sessionId: string, message: unknown) =>
      attempt(async () => {
        const host = hosts.get(ownerId);
        if (!host) throw new Error("Gateway disabled.");
        await host.send(sessionId, message);
      }),
    closeSession: (ownerId: number, sessionId: string) =>
      attempt(async () => {
        await hosts.get(ownerId)?.closeSession(sessionId);
      }),
  };
});

export class ManagedMcpGateway extends Context.Service<
  ManagedMcpGateway,
  Effect.Success<typeof make>
>()("@t3tools/desktop/ManagedMcpGateway") {}
export const layer = Layer.effect(ManagedMcpGateway, make);
