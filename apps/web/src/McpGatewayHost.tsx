import {
  connectGatewayBridge,
  createGatewayRuntimeEventSourceFromContext,
  createGatewayRuntimePortFromContext,
  serveGatewayPortRelays,
} from "@t3tools/client-runtime/gateway";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import type { AppRouter } from "./router";
import { openDesktopGatewayThread, openDesktopGatewayAgents } from "./mcpGatewayNavigation";
import { connectionAtomRuntime } from "./connection/runtime";
import {
  getMcpGatewayGrants,
  getMcpGatewayPort,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  mcpGatewayStartupMessage,
  publishMcpGatewayStartup,
  publishMcpGatewayStatus,
  publishMcpGatewayStatusSnapshot,
  setMcpGatewayStatusRequester,
  setMcpGatewayRestarter,
  subscribeMcpGatewayConfiguration,
} from "./mcpGatewayState";
import { appAtomRegistry } from "./rpc/atomRegistry";

export function McpGatewayHost({ router }: { readonly router: AppRouter }) {
  const [configuration, setConfiguration] = useState(() => ({
    available: (window.desktopBridge?.getMcpGatewayLaunchConfig?.() ?? null) !== null,
    enabled: isMcpGatewayEnabled(),
    port: getMcpGatewayPort(),
    grants: getMcpGatewayGrants(),
    token: getMcpGatewayToken(),
  }));

  useEffect(() => {
    const onChange = () =>
      setConfiguration({
        available: (window.desktopBridge?.getMcpGatewayLaunchConfig?.() ?? null) !== null,
        enabled: isMcpGatewayEnabled(),
        port: getMcpGatewayPort(),
        grants: getMcpGatewayGrants(),
        token: getMcpGatewayToken(),
      });
    return subscribeMcpGatewayConfiguration(onChange);
  }, []);

  const [restartVersion, setRestartVersion] = useState(0);
  // Another host's gateway can hold the port with a different store; the desktop takes over
  // once it exits, without the user having to press Restart.
  const [retryVersion, setRetryVersion] = useState(0);
  const startupFailures = useRef(0);
  useEffect(() => {
    setMcpGatewayRestarter(() => {
      startupFailures.current = 0;
      setRestartVersion((version) => version + 1);
    });
    return () => setMcpGatewayRestarter(null);
  }, []);

  const nativeConfiguration = useMemo(
    () => ({
      enabled: configuration.available && configuration.enabled && configuration.token.length >= 16,
      token: configuration.token,
      port: configuration.port,
      restartVersion,
      retryVersion,
    }),
    [
      configuration.available,
      configuration.enabled,
      configuration.token,
      configuration.port,
      restartVersion,
      retryVersion,
    ],
  );
  const [readyConfiguration, setReadyConfiguration] = useState<typeof nativeConfiguration | null>(
    null,
  );
  const managedReady = nativeConfiguration.enabled && readyConfiguration === nativeConfiguration;
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const desktop = window.desktopBridge;
    if (!desktop?.configureManagedMcpGateway) return;
    publishMcpGatewayStartup({ phase: "starting" });
    void desktop
      .configureManagedMcpGateway(
        nativeConfiguration.enabled
          ? { token: nativeConfiguration.token, port: nativeConfiguration.port }
          : null,
      )
      .then(
        () => {
          if (stopped) return;
          startupFailures.current = 0;
          setReadyConfiguration(nativeConfiguration);
          publishMcpGatewayStartup({ phase: "ready" });
        },
        (error: unknown) => {
          if (stopped) return;
          const message = mcpGatewayStartupMessage(error);
          console.error("MCP gateway startup failed", message);
          publishMcpGatewayStatus("degraded");
          publishMcpGatewayStartup({ phase: "failed", message });
          if (!nativeConfiguration.enabled) return;
          startupFailures.current += 1;
          retry = setTimeout(
            () => setRetryVersion((version) => version + 1),
            Math.min(1_000 * 2 ** (startupFailures.current - 1), 30_000),
          );
        },
      );
    return () => {
      stopped = true;
      clearTimeout(retry);
      void desktop
        .configureManagedMcpGateway?.(null)
        .catch(() => console.error("MCP gateway shutdown failed"));
    };
  }, [nativeConfiguration]);

  useEffect(() => {
    if (
      !configuration.available ||
      !configuration.enabled ||
      configuration.token.length < 16 ||
      !managedReady
    ) {
      publishMcpGatewayStatus(configuration.enabled ? "degraded" : "disabled");
      publishMcpGatewayStatusSnapshot(null);
      setMcpGatewayStatusRequester(null);
      return;
    }

    const unmountRuntime = appAtomRegistry.mount(connectionAtomRuntime);
    let bridge: ReturnType<typeof connectGatewayBridge> | null = null;
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    let stopRelays: (() => void) | undefined;
    const startWhenReady = () => {
      if (stopped || bridge !== null) return;
      const value = AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime));
      if (Option.isNone(value)) return;
      const port = createGatewayRuntimePortFromContext(
        value.value,
        (environmentId, threadId) =>
          openDesktopGatewayThread(router, window.desktopBridge, environmentId, threadId),
        () => openDesktopGatewayAgents(router, window.desktopBridge),
      );
      bridge = connectGatewayBridge({
        port,
        events: createGatewayRuntimeEventSourceFromContext(value.value),
        grants: configuration.grants,
        token: configuration.token,
        url: `ws://127.0.0.1:${configuration.port}`,
        onState: (state) => {
          publishMcpGatewayStatus(state);
          // Agents in granted environments' chats reach the other granted environments
          // through this app, under the same grants as the gateway.
          if (state === "running" && !stopRelays) {
            // A relay resubscribes on its own and says nothing about the local bridge's health.
            stopRelays = serveGatewayPortRelays(value.value, port, configuration.grants, (error) =>
              console.error("MCP gateway relay failed", error),
            );
          } else if (state === "degraded" || state === "disabled") {
            stopRelays?.();
            stopRelays = undefined;
          }
        },
        onStatusSnapshot: publishMcpGatewayStatusSnapshot,
      });
      setMcpGatewayStatusRequester(() => bridge?.requestStatus() ?? false);
      unsubscribe?.();
      unsubscribe = null;
    };
    startWhenReady();
    if (bridge === null)
      unsubscribe = appAtomRegistry.subscribe(connectionAtomRuntime, startWhenReady);

    return () => {
      stopped = true;
      unsubscribe?.();
      stopRelays?.();
      bridge?.stop();
      setMcpGatewayStatusRequester(null);
      publishMcpGatewayStatusSnapshot(null);
      unmountRuntime();
    };
  }, [configuration, router, managedReady]);

  return null;
}
