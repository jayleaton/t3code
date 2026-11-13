import { agentGatewayStatusLabel } from "@t3tools/client-runtime/gateway";
import type { EnvironmentId } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "../../state/environments";
import { useServerAgentGatewayStatus } from "../settings/ServerAgentGatewaySettings";

/** Outside the desktop app, the gateway this environment's server hosts for itself. */
export function ServerAgentGatewayStatus() {
  const environment = usePrimaryEnvironment();
  const supported =
    environment !== null &&
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.agentGateway === true;
  return supported ? (
    <ServerAgentGatewayLabel environmentId={environment.environmentId} />
  ) : (
    <GatewayLabel label="Desktop only" connected={false} />
  );
}

function ServerAgentGatewayLabel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const status = useServerAgentGatewayStatus(environmentId);
  return (
    <GatewayLabel
      label={status === null ? "Loading…" : agentGatewayStatusLabel(status)}
      connected={status?.host === "server" && status.enabled && status.state === "running"}
    />
  );
}

function GatewayLabel({
  label,
  connected,
}: {
  readonly label: string;
  readonly connected: boolean;
}) {
  return (
    <div className="agent-gateway" data-connected={connected}>
      <span role="status" aria-live="polite">
        <span className="agent-gateway-dot" aria-hidden="true" />
        Agent gateway <span className="text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}
