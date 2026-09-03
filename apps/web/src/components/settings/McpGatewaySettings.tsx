import type { GatewayScope } from "@t3tools/client-runtime/gateway";
import { ServerCogIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getMcpGatewayGrants,
  getMcpGatewayStatus,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  MCP_GATEWAY_STATE_EVENT,
  type McpGatewayGrants,
  type McpGatewayUiState,
  setMcpGatewayEnabled,
  setMcpGatewayGrants,
  setMcpGatewayToken,
} from "../../mcpGatewayState";

const GATEWAY_SCOPES = ["read", "create", "send"] as const;

export function updateMcpGatewayGrant(
  grants: McpGatewayGrants,
  environmentId: string,
  scope: GatewayScope,
  checked: boolean,
): McpGatewayGrants {
  const current = grants[environmentId] ?? [];
  const nextScopes = checked
    ? [...new Set([...current, scope])]
    : current.filter((candidate) => candidate !== scope);
  const next = { ...grants };
  if (nextScopes.length === 0) delete next[environmentId];
  else next[environmentId] = nextScopes;
  return next;
}

export function McpEnvironmentGrantMatrix({
  environments,
  grants,
  onChange,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly connectionState: string;
  }>;
  readonly grants: McpGatewayGrants;
  readonly onChange: (grants: McpGatewayGrants) => void;
}) {
  const registeredIds = new Set(environments.map((environment) => environment.environmentId));
  const visibleEnvironments = [
    ...environments.map((environment) => ({ ...environment, registered: true })),
    ...Object.keys(grants)
      .filter((environmentId) => !registeredIds.has(environmentId))
      .sort()
      .map((environmentId) => ({
        environmentId,
        label: "Unavailable environment",
        connectionState: "unavailable",
        registered: false,
      })),
  ];
  const toggleScope = (environmentId: string, scope: GatewayScope, checked: boolean) => {
    onChange(updateMcpGatewayGrant(grants, environmentId, scope, checked));
  };

  if (visibleEnvironments.length === 0) {
    return <p className="text-sm text-muted-foreground">No registered environments.</p>;
  }

  return (
    <div className="space-y-3">
      {visibleEnvironments.map((environment) => (
        <div key={environment.environmentId} className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{environment.label}</div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {environment.environmentId}
              </div>
            </div>
            <span className="text-xs text-muted-foreground">{environment.connectionState}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            {GATEWAY_SCOPES.map((scope) => {
              const checked = grants[environment.environmentId]?.includes(scope) ?? false;
              return (
                <label key={scope} className="flex items-center gap-2 text-sm capitalize">
                  <Checkbox
                    checked={checked}
                    disabled={!environment.registered && !checked}
                    aria-label={`Grant ${scope} access to ${environment.label}`}
                    onCheckedChange={(nextChecked) =>
                      toggleScope(environment.environmentId, scope, nextChecked === true)
                    }
                  />
                  {scope}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function McpGatewaySettings() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [token, setToken] = useState(getMcpGatewayToken);
  const [grants, setGrants] = useState(getMcpGatewayGrants);
  const [status, setStatus] = useState<McpGatewayUiState>(() =>
    enabled ? getMcpGatewayStatus() : "disabled",
  );

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<McpGatewayUiState>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
  }, []);

  return (
    <SettingsPageContainer>
      <SettingsSection title="MCP Gateway" icon={<ServerCogIcon className="size-5" />}>
        <SettingsRow
          id="enable-mcp-gateway"
          title="Enable MCP Gateway"
          description="Connect this client runtime to the local T3 MCP companion. Disabled by default; when disabled no gateway socket or session is created."
          status={`Status: ${status}`}
          control={
            <Switch
              checked={enabled}
              aria-label="Enable MCP Gateway"
              onCheckedChange={(checked) => {
                const next = Boolean(checked);
                setEnabled(next);
                setStatus(next ? "connecting" : "disabled");
                setMcpGatewayToken(token);
                setMcpGatewayEnabled(next);
              }}
            />
          }
        />
        <SettingsRow
          id="mcp-gateway-bridge-token"
          title="Bridge token"
          description="Set this to the same T3_MCP_BRIDGE_TOKEN configured in the MCP host. It is kept only for this browser session."
          control={
            <Input
              value={token}
              type="password"
              autoComplete="off"
              placeholder="At least 16 characters"
              aria-label="MCP gateway bridge token"
              onChange={(event) => setToken(event.target.value)}
              onBlur={() => setMcpGatewayToken(token)}
            />
          }
        />
        <SettingsRow
          id="mcp-gateway-environment-grants"
          title="Environment grants"
          description="Choose exact registered environments and scopes for this MCP host. Nothing is granted by default."
        >
          <McpEnvironmentGrantMatrix
            environments={environments.map((environment) => ({
              environmentId: environment.environmentId,
              label: environment.label,
              connectionState: environment.connection.phase,
            }))}
            grants={grants}
            onChange={(next) => {
              setGrants(next);
              setMcpGatewayGrants(next);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Companion endpoint"
          description="Start t3-mcp-gateway in your MCP host with T3_MCP_BRIDGE_TOKEN. The companion listens only on loopback, rejects unauthenticated clients, and receives the persisted environment grants above after authentication."
          status="ws://127.0.0.1:47631"
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
