import {
  connectGatewayBridge,
  createGatewayRuntimePortFromContext,
  type GatewayBridgeState,
} from "@t3tools/client-runtime/gateway";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "./connection/runtime";
import {
  getMcpGatewayGrants,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  MCP_GATEWAY_STATE_EVENT,
  type McpGatewayUiState,
} from "./mcpGatewayState";
import { appAtomRegistry } from "./rpc/atomRegistry";

const BRIDGE_URL = "ws://127.0.0.1:47631";

function publishState(state: GatewayBridgeState) {
  window.dispatchEvent(
    new CustomEvent<McpGatewayUiState>(`${MCP_GATEWAY_STATE_EVENT}:status`, { detail: state }),
  );
}

export function McpGatewayHost() {
  const [configuration, setConfiguration] = useState(() => ({
    enabled: isMcpGatewayEnabled(),
    grants: getMcpGatewayGrants(),
    token: getMcpGatewayToken(),
  }));

  useEffect(() => {
    const onChange = () =>
      setConfiguration({
        enabled: isMcpGatewayEnabled(),
        grants: getMcpGatewayGrants(),
        token: getMcpGatewayToken(),
      });
    window.addEventListener(MCP_GATEWAY_STATE_EVENT, onChange);
    return () => window.removeEventListener(MCP_GATEWAY_STATE_EVENT, onChange);
  }, []);

  useEffect(() => {
    if (!configuration.enabled || configuration.token.length < 16) {
      publishState(configuration.enabled ? "degraded" : "disabled");
      return;
    }

    const unmountRuntime = appAtomRegistry.mount(connectionAtomRuntime);
    let bridge: ReturnType<typeof connectGatewayBridge> | null = null;
    let unsubscribe: (() => void) | null = null;
    let stopped = false;
    const startWhenReady = () => {
      if (stopped || bridge !== null) return;
      const value = AsyncResult.value(appAtomRegistry.get(connectionAtomRuntime));
      if (Option.isNone(value)) return;
      bridge = connectGatewayBridge({
        port: createGatewayRuntimePortFromContext(value.value),
        grants: configuration.grants,
        token: configuration.token,
        url: BRIDGE_URL,
        onState: publishState,
      });
      unsubscribe?.();
      unsubscribe = null;
    };
    startWhenReady();
    if (bridge === null)
      unsubscribe = appAtomRegistry.subscribe(connectionAtomRuntime, startWhenReady);

    return () => {
      stopped = true;
      unsubscribe?.();
      bridge?.stop();
      unmountRuntime();
    };
  }, [configuration]);

  return null;
}
