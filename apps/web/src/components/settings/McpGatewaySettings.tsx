import { GATEWAY_SCOPE_VALUES } from "@t3tools/client-runtime/gateway";
import type { GatewayScope } from "@t3tools/client-runtime/gateway";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { McpGatewayProfile } from "@t3tools/contracts/settings";
import { ServerCogIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";

import { useEnvironments } from "../../state/environments";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getMcpGatewayGrants,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  MCP_GATEWAY_STATE_EVENT,
  type McpGatewayGrants,
  type McpGatewayUiState,
  setMcpGatewayEnabled,
  setMcpGatewayGrants,
  setMcpGatewayToken,
} from "../../mcpGatewayState";

const GATEWAY_SCOPES = GATEWAY_SCOPE_VALUES.filter((scope) => scope !== "control");

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

export function McpProfileList({
  profiles,
  onChange,
}: {
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly onChange: (profiles: ReadonlyArray<McpGatewayProfile>) => void;
}) {
  const [name, setName] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [runtimeMode, setRuntimeMode] =
    useState<McpGatewayProfile["runtimeMode"]>("approval-required");

  return (
    <div className="space-y-3">
      {profiles.map((profile) => (
        <div
          key={profile.name}
          className="flex items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0 text-sm">
            <div className="font-medium">{profile.name}</div>
            <div className="break-all text-xs text-muted-foreground">
              {profile.modelSelection.instanceId} / {profile.modelSelection.model} ·{" "}
              {profile.reasoningEffort === undefined ? "default effort" : profile.reasoningEffort} ·{" "}
              {profile.runtimeMode} · revision {profile.revision ?? 0}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${profile.name} profile`}
            onClick={() =>
              onChange(profiles.filter((candidate) => candidate.name !== profile.name))
            }
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      ))}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={name}
          placeholder="Profile name"
          aria-label="Profile name"
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          value={instanceId}
          placeholder="Provider instance ID"
          aria-label="Profile provider instance ID"
          onChange={(event) => setInstanceId(event.target.value)}
        />
        <Input
          value={model}
          placeholder="Model ID"
          aria-label="Profile model ID"
          onChange={(event) => setModel(event.target.value)}
        />
        <Input
          value={reasoningEffort}
          placeholder="Reasoning effort (for example, medium)"
          aria-label="Profile reasoning effort"
          onChange={(event) => setReasoningEffort(event.target.value)}
        />
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          aria-label="Profile runtime mode"
          value={runtimeMode}
          onChange={(event) =>
            setRuntimeMode(event.target.value as McpGatewayProfile["runtimeMode"])
          }
        >
          <option value="approval-required">approval-required</option>
          <option value="auto-accept-edits">auto-accept-edits</option>
          <option value="auto">auto</option>
          <option value="full-access">full-access</option>
          <option value="read-only">read-only</option>
        </select>
      </div>
      <Button
        variant="outline"
        disabled={name.trim() === "" || instanceId.trim() === "" || model.trim() === ""}
        onClick={() => {
          const now = new globalThis.Date().toISOString();
          const existing = profiles.find((candidate) => candidate.name === name.trim());
          const profile: McpGatewayProfile = {
            profileId: existing?.profileId ?? `profile_${randomUUID()}`,
            name: name.trim(),
            modelSelection: {
              instanceId: ProviderInstanceId.make(instanceId.trim()),
              model: model.trim(),
            },
            ...(reasoningEffort.trim() === "" ? {} : { reasoningEffort: reasoningEffort.trim() }),
            runtimeMode,
            interactionMode: "default",
            revision: (existing?.revision ?? 0) + 1,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          onChange([...profiles.filter((candidate) => candidate.name !== profile.name), profile]);
          setName("");
          setInstanceId("");
          setModel("");
          setReasoningEffort("");
        }}
      >
        Save profile
      </Button>
    </div>
  );
}

export function McpGatewaySettings() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [token, setToken] = useState(getMcpGatewayToken);
  const [grants, setGrants] = useState(getMcpGatewayGrants);
  const profiles = usePrimarySettings((settings) => settings.mcpGatewayProfiles);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const [status, setStatus] = useState<McpGatewayUiState>(enabled ? "connecting" : "disabled");

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
          id="mcp-gateway-profiles"
          title="Named profiles"
          description="Save model and execution defaults for MCP-created threads. Values are copied into each new thread; later profile edits do not mutate existing work."
        >
          <McpProfileList
            profiles={profiles}
            onChange={(next) => updatePrimarySettings({ mcpGatewayProfiles: next })}
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
