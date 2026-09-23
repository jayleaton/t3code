import { useEffect, useRef, useState } from "react";
import {
  getMcpGatewayStatus,
  getMcpGatewayStatusSnapshot,
  isMcpGatewayEnabled,
  MCP_GATEWAY_STATE_EVENT,
  requestMcpGatewayStatusSnapshot,
  restartMcpGateway,
  subscribeMcpGatewayConfiguration,
} from "../../mcpGatewayState";

/** Health belongs to the authenticated local bridge, not the desktop process or devices. */
export function AgentGatewayStatus() {
  const available = Boolean(window.desktopBridge?.getMcpGatewayLaunchConfig?.());
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [status, setStatus] = useState(getMcpGatewayStatus);
  const [live, setLive] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const responseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!available) return;
    const refresh = () => {
      clearTimeout(responseTimer.current);
      if (!isMcpGatewayEnabled()) return;
      try {
        if (!requestMcpGatewayStatusSnapshot()) {
          setLive(false);
          return;
        }
        responseTimer.current = setTimeout(() => {
          setLive(false);
          setError("Gateway did not respond. Try restarting it.");
        }, 5_000);
      } catch {
        setLive(false);
        setError("Gateway status could not be checked. Try restarting it.");
      }
    };
    const onStatus = () => {
      const next = getMcpGatewayStatus();
      setStatus(next);
      setLive(false);
      if (next === "running") refresh();
    };
    const onSnapshot = () => {
      const snapshot = getMcpGatewayStatusSnapshot();
      const healthy =
        getMcpGatewayStatus() === "running" && Boolean(snapshot?.live && !snapshot.stale);
      setLive(healthy);
      if (!healthy) return;
      clearTimeout(responseTimer.current);
      clearTimeout(recoveryTimer.current);
      setRecovering(false);
      setError(null);
    };
    const unsubscribe = subscribeMcpGatewayConfiguration(() => {
      setEnabled(isMcpGatewayEnabled());
      setLive(false);
      setError(null);
      setRecovering(false);
      clearTimeout(recoveryTimer.current);
      refresh();
    });
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onSnapshot);
    window.addEventListener("focus", refresh);
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => {
      unsubscribe();
      window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
      window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onSnapshot);
      window.removeEventListener("focus", refresh);
      clearInterval(interval);
      clearTimeout(responseTimer.current);
      clearTimeout(recoveryTimer.current);
    };
  }, [available]);

  const connected = available && enabled && status === "running" && live && !error;
  const label = !available
    ? "Desktop only"
    : !enabled
      ? "Disabled"
      : recovering
        ? "Recovering…"
        : error
          ? "Failed"
          : connected
            ? "Connected"
            : status === "connecting"
              ? "Connecting…"
              : "Disconnected";
  return (
    <div className="agent-gateway" data-connected={connected && !recovering}>
      <span
        role="status"
        aria-live="polite"
        aria-description="Local gateway bridge health; device connectivity is shown separately."
      >
        <span className="agent-gateway-dot" aria-hidden="true" />
        Agent gateway <span className="text-muted-foreground">{label}</span>
      </span>
      {available && enabled && !connected && (
        <button
          type="button"
          className="agent-icon-button"
          disabled={recovering}
          aria-label="Restart agent gateway"
          onClick={() => {
            if (recovering) return;
            setError(null);
            setLive(false);
            setRecovering(true);
            try {
              if (!restartMcpGateway()) throw new Error("Unavailable");
              recoveryTimer.current = setTimeout(() => {
                setRecovering(false);
                setError("Gateway recovery failed. Try again or check MCP Gateway settings.");
              }, 15_000);
            } catch {
              setRecovering(false);
              setError("Gateway restart is unavailable. Check MCP Gateway settings.");
            }
          }}
        >
          {recovering ? "Restarting…" : "Restart"}
        </button>
      )}
      {error && enabled && !recovering && (
        <span className="agent-gateway-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
