import { GATEWAY_SCOPE_VALUES } from "@t3tools/client-runtime/gateway";
import type { GatewayScope } from "@t3tools/client-runtime/gateway";
import {
  formatMcpGatewayProfileSummary,
  MCP_GATEWAY_RUNTIME_MODE_LABELS,
  type McpGatewayProfile,
} from "@t3tools/contracts/settings";
import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  ServerCogIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useAtomValue } from "@effect/atom-react";
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

/** Scope set applied by the machine-level `On` baseline (spec §9.2). */
const GRANTED_SCOPES: ReadonlyArray<GatewayScope> = GATEWAY_SCOPE_VALUES.filter(
  (scope) => scope !== "control",
);

const SCOPE_LABELS: Record<GatewayScope, string> = {
  read: "Read",
  create: "Create",
  send: "Send",
  control: "Control",
  lifecycle: "Lifecycle",
  approval: "Approval",
  artifact: "Artifact",
  review: "Review",
  admin: "Admin",
  delivery: "Delivery",
};

const UNSELECTED_PROVIDER = "—";

const GATEWAY_SCOPES: ReadonlyArray<GatewayScope> = GRANTED_SCOPES;

export interface McpGrantEnvironmentRow {
  readonly environmentId: string;
  readonly label: string;
  readonly connectionState: string;
}

function scopesFor(grants: McpGatewayGrants, environmentId: string): ReadonlyArray<GatewayScope> {
  return grants[environmentId] ?? [];
}

function isGrantOn(grants: McpGatewayGrants, environmentId: string): boolean {
  return (grants[environmentId] ?? []).length > 0;
}

function setEnvironmentScopes(
  grants: McpGatewayGrants,
  environmentId: string,
  scopes: ReadonlyArray<GatewayScope>,
): McpGatewayGrants {
  const next = { ...grants };
  if (scopes.length === 0) delete next[environmentId];
  else next[environmentId] = [...scopes];
  return next;
}

export function toggleMcpGatewayGrantForAll(
  grants: McpGatewayGrants,
  environments: ReadonlyArray<McpGrantEnvironmentRow>,
): McpGatewayGrants {
  const next = { ...grants };
  const allOn =
    environments.length > 0 &&
    environments.every((environment) => isGrantOn(grants, environment.environmentId));
  for (const environment of environments) {
    if (allOn) delete next[environment.environmentId];
    else next[environment.environmentId] = [...GRANTED_SCOPES];
  }
  return next;
}

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
  return setEnvironmentScopes(grants, environmentId, nextScopes);
}

/**
 * Machine-first grant matrix (spec §9.2). One machine-level Off/On control
 * per row, a Select all action over the visible rows with indeterminate
 * mixed state, and a compact per-machine dropdown for the baseline plus
 * fine-grained scope tweaks. All edits stay in the caller's pending form
 * until Save.
 */
export function McpEnvironmentGrantMatrix({
  environments,
  grants,
  onChange,
}: {
  readonly environments: ReadonlyArray<McpGrantEnvironmentRow>;
  readonly grants: McpGatewayGrants;
  readonly onChange: (grants: McpGatewayGrants) => void;
}) {
  const registeredIds = new Set(environments.map((environment) => environment.environmentId));
  const visibleEnvironments = [
    ...environments,
    ...Object.keys(grants)
      .filter((environmentId) => !registeredIds.has(environmentId))
      .sort()
      .map((environmentId): McpGrantEnvironmentRow => ({
        environmentId,
        label: "Unavailable environment",
        connectionState: "unavailable",
      })),
  ];

  if (visibleEnvironments.length === 0) {
    return <p className="text-sm text-muted-foreground">No registered environments.</p>;
  }

  const allOn = visibleEnvironments.every((environment) =>
    isGrantOn(grants, environment.environmentId),
  );
  const anyOn = visibleEnvironments.some((environment) =>
    isGrantOn(grants, environment.environmentId),
  );

  const selectAll = () => onChange(toggleMcpGatewayGrantForAll(grants, visibleEnvironments));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allOn}
            indeterminate={!allOn && anyOn}
            aria-label="Select all environments"
            onCheckedChange={selectAll}
          />
          Select all
        </label>
        <span className="text-xs text-muted-foreground">
          {allOn ? "All listed machines on" : anyOn ? "Mixed selection" : "All listed machines off"}
        </span>
      </div>
      {visibleEnvironments.map((environment) => {
        const on = isGrantOn(grants, environment.environmentId);
        const scopes = scopesFor(grants, environment.environmentId);
        return (
          <div key={environment.environmentId} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{environment.label}</div>
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {environment.environmentId}
                </div>
              </div>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Access for ${environment.label}`}
                    />
                  }
                >
                  <span className="min-w-0 truncate">{on ? "On" : "Off"}</span>
                  <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
                </MenuTrigger>
                <MenuPopup align="end" className="w-56">
                  <MenuRadioGroup
                    value={on ? "on" : "off"}
                    onValueChange={(value) => {
                      onChange(
                        setEnvironmentScopes(
                          grants,
                          environment.environmentId,
                          value === "on" ? GRANTED_SCOPES : [],
                        ),
                      );
                    }}
                  >
                    <MenuRadioItem value="off">Off</MenuRadioItem>
                    <MenuRadioItem value="on">On (default access)</MenuRadioItem>
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Adjust capabilities</MenuGroupLabel>
                    {GATEWAY_SCOPES.map((scope: GatewayScope) => (
                      <MenuCheckboxItem
                        key={scope}
                        checked={scopes.includes(scope)}
                        onCheckedChange={(checked) => {
                          onChange(
                            updateMcpGatewayGrant(
                              grants,
                              environment.environmentId,
                              scope,
                              checked,
                            ),
                          );
                        }}
                      >
                        {SCOPE_LABELS[scope] ?? scope}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            </div>
            {scopes.length > 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                {scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ")}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface ProfileDraft {
  readonly name: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly instanceId: string | null;
  readonly providerLabel: string;
  readonly model: string | null;
  readonly modelLabel: string;
  readonly reasoningEffort: string | null;
  readonly runtimeMode: McpGatewayProfile["runtimeMode"];
}

const EMPTY_DRAFT: ProfileDraft = {
  name: "",
  driverKind: null,
  instanceId: null,
  providerLabel: "",
  model: null,
  modelLabel: "",
  reasoningEffort: null,
  runtimeMode: "approval-required",
};

const REASONING_EFFORTS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

interface ProviderPickerEntry {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: string;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly isReady: boolean;
}

/**
 * Provider catalog for the profile pickers, projected from the live server
 * provider snapshots the rest of the app uses (spec §9.2: "populated from
 * the provider catalog T3 currently supports"). Entries are grouped by
 * driver kind so the provider dropdown shows readable display labels, and
 * the model dropdown filters to the selected instance's models.
 */
export function deriveProfileProviderEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderPickerEntry> {
  return providers
    .filter((provider) => provider.enabled && provider.availability !== "unavailable")
    .map((provider) => ({
      driverKind: provider.driver,
      instanceId: provider.instanceId,
      label: provider.displayName?.trim() || provider.driver,
      models: provider.models.map((model) => ({ slug: model.slug, name: model.name })),
      isReady: provider.status === "ready",
    }));
}

function formatReasoningLabel(value: string): string {
  return REASONING_EFFORTS.find((effort) => effort.value === value)?.label ?? value;
}

/**
 * Named-profile editor (spec §9.2). Provider and model are dropdowns over
 * the live catalog — users never type instance or model IDs. The persisted
 * profile stores the readable labels; the routing selection is captured in
 * the draft only and resolved at thread creation.
 */
export function McpProfileList({
  profiles,
  providers,
  onChange,
}: {
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (profiles: ReadonlyArray<McpGatewayProfile>) => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [editingName, setEditingName] = useState<string | null>(null);
  const providerEntries = useMemo(() => deriveProfileProviderEntries(providers), [providers]);
  const selectedEntry =
    draft.instanceId === null
      ? undefined
      : providerEntries.find((entry) => entry.instanceId === draft.instanceId);
  const existing =
    editingName === null ? undefined : profiles.find((profile) => profile.name === editingName);

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setEditingName(null);
  };

  const startEdit = (profile: McpGatewayProfile) => {
    setEditingName(profile.name);
    const entry = providerEntries.find(
      (candidate) =>
        candidate.label === profile.providerLabel &&
        candidate.models.some((model) => model.name === profile.modelLabel),
    );
    const model =
      entry === undefined
        ? null
        : (entry.models.find((candidate) => candidate.name === profile.modelLabel)?.slug ?? null);
    setDraft({
      name: profile.name,
      driverKind: entry?.driverKind ?? null,
      instanceId: entry?.instanceId ?? null,
      providerLabel: profile.providerLabel ?? "",
      model,
      modelLabel: profile.modelLabel ?? "",
      reasoningEffort: profile.reasoningEffort ?? null,
      runtimeMode: profile.runtimeMode,
    });
  };

  const unresolved =
    editingName !== null &&
    existing !== undefined &&
    (selectedEntry === undefined ||
      draft.model === null ||
      (existing.providerLabel !== undefined && existing.providerLabel !== selectedEntry.label) ||
      (existing.modelLabel !== undefined &&
        existing.modelLabel !==
          selectedEntry.models.find((candidate) => candidate.slug === draft.model)?.name));

  const canSave = draft.name.trim() !== "" && selectedEntry !== undefined && draft.model !== null;

  return (
    <div className="space-y-3">
      {profiles.map((profile) => {
        const entry = providerEntries.find(
          (candidate) => candidate.label === profile.providerLabel,
        );
        const modelStillExists =
          profile.modelLabel !== undefined &&
          (entry?.models.some((candidate) => candidate.name === profile.modelLabel) ?? false);
        const unavailable = entry === undefined || !modelStillExists;
        return (
          <div
            key={profile.name}
            className="flex items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 text-sm">
              <div className="flex items-center gap-2 font-medium">
                {profile.name}
                {unavailable ? (
                  <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                    <CircleAlertIcon className="size-3" />
                    unavailable — re-select
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatMcpGatewayProfileSummary(profile, unavailable)} · revision {profile.revision}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Edit ${profile.name} profile`}
                onClick={() => startEdit(profile)}
              >
                <ArrowUpDownIcon className="size-4" />
              </Button>
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
          </div>
        );
      })}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={draft.name}
          placeholder="Profile name"
          aria-label="Profile name"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <Select
          value={draft.instanceId ?? UNSELECTED_PROVIDER}
          onValueChange={(value) => {
            const entry = providerEntries.find((candidate) => candidate.instanceId === value);
            setDraft({
              ...draft,
              driverKind: entry?.driverKind ?? null,
              instanceId: entry?.instanceId ?? null,
              providerLabel: entry?.label ?? "",
              // Provider change clears an incompatible model (spec §9.2).
              model: null,
              modelLabel: "",
            });
          }}
        >
          <SelectTrigger size="sm" aria-label="Profile provider">
            <SelectValue>
              {selectedEntry === undefined ? "Select provider" : selectedEntry.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup className="min-w-64">
            {providerEntries.length === 0 ? (
              <SelectItem value={UNSELECTED_PROVIDER} disabled>
                No providers available
              </SelectItem>
            ) : (
              providerEntries.map((entry) => (
                <SelectItem key={entry.instanceId} value={entry.instanceId}>
                  <span className="flex w-full items-center justify-between gap-5">
                    <span>{entry.label}</span>
                    {!entry.isReady ? (
                      <span className="text-xs text-muted-foreground">unavailable</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))
            )}
          </SelectPopup>
        </Select>
        <Select
          value={draft.model ?? UNSELECTED_PROVIDER}
          disabled={selectedEntry === undefined}
          onValueChange={(value) => {
            const model = selectedEntry?.models.find((candidate) => candidate.slug === value);
            setDraft({
              ...draft,
              model: model?.slug ?? null,
              modelLabel: model?.name ?? "",
            });
          }}
        >
          <SelectTrigger size="sm" aria-label="Profile model">
            <SelectValue>{draft.modelLabel === "" ? "Select model" : draft.modelLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup className="min-w-64">
            {(selectedEntry?.models ?? []).length === 0 ? (
              <SelectItem value={UNSELECTED_PROVIDER} disabled>
                No models available
              </SelectItem>
            ) : (
              (selectedEntry?.models ?? []).map((model) => (
                <SelectItem key={model.slug} value={model.slug}>
                  {model.name}
                </SelectItem>
              ))
            )}
          </SelectPopup>
        </Select>
        <Select
          value={draft.reasoningEffort ?? "default"}
          onValueChange={(value) => {
            setDraft({
              ...draft,
              reasoningEffort: value === "default" ? null : value,
            });
          }}
        >
          <SelectTrigger size="sm" aria-label="Profile reasoning effort">
            <SelectValue>
              {draft.reasoningEffort === null
                ? "Default reasoning"
                : `${formatReasoningLabel(draft.reasoningEffort)} reasoning`}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup className="min-w-64">
            <SelectItem value="default">Default reasoning</SelectItem>
            {REASONING_EFFORTS.map((effort) => (
              <SelectItem key={effort.value} value={effort.value}>
                {effort.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={draft.runtimeMode}
          onValueChange={(value) => {
            setDraft({ ...draft, runtimeMode: value as ProfileDraft["runtimeMode"] });
          }}
        >
          <SelectTrigger size="sm" aria-label="Profile runtime mode">
            <SelectValue>{MCP_GATEWAY_RUNTIME_MODE_LABELS[draft.runtimeMode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup className="min-w-64">
            {(
              Object.keys(MCP_GATEWAY_RUNTIME_MODE_LABELS) as Array<ProfileDraft["runtimeMode"]>
            ).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {MCP_GATEWAY_RUNTIME_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {unresolved ? (
        <p className="text-xs text-destructive" role="note">
          The saved provider or model is no longer offered. Re-select both before saving.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={!canSave}
          onClick={() => {
            const entry = selectedEntry;
            const model = entry?.models.find((candidate) => candidate.slug === draft.model);
            if (entry === undefined || model === undefined) return;
            const now = new globalThis.Date().toISOString();
            const name = draft.name.trim();
            const previous = profiles.find((candidate) => candidate.name === name);
            // Persist readable labels only. The instance/model routing keys
            // stay in this draft — they are never serialized into the
            // profile (spec §9.2).
            const profile: McpGatewayProfile = {
              profileId: previous?.profileId ?? `profile_${randomUUID()}`,
              name,
              providerLabel: entry.label,
              modelLabel: model.name,
              ...(draft.reasoningEffort === null ? {} : { reasoningEffort: draft.reasoningEffort }),
              runtimeMode: draft.runtimeMode,
              interactionMode: previous?.interactionMode ?? "default",
              revision: (previous?.revision ?? 0) + 1,
              createdAt: previous?.createdAt ?? now,
              updatedAt: now,
            };
            onChange([...profiles.filter((candidate) => candidate.name !== profile.name), profile]);
            resetDraft();
          }}
        >
          {editingName === null ? "Save profile" : `Update ${editingName}`}
        </Button>
        {editingName !== null || draft !== EMPTY_DRAFT ? (
          <Button variant="ghost" onClick={resetDraft}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function McpGatewaySettings() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [token, setToken] = useState(getMcpGatewayToken);
  const [savedGrants, setSavedGrants] = useState(getMcpGatewayGrants);
  const [pendingGrants, setPendingGrants] = useState<McpGatewayGrants | null>(null);
  const profiles = usePrimarySettings((settings) => settings.mcpGatewayProfiles);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updatePrimarySettings = useUpdatePrimarySettings();
  const [status, setStatus] = useState<McpGatewayUiState>(enabled ? "connecting" : "disabled");

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<McpGatewayUiState>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
  }, []);

  const grantsDirty =
    pendingGrants !== null && JSON.stringify(pendingGrants) !== JSON.stringify(savedGrants);

  const environmentRows: ReadonlyArray<McpGrantEnvironmentRow> = environments.map(
    (environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connectionState: environment.connection.phase,
    }),
  );

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
          description="One access control per machine: off by default, or on with the baseline capabilities. Fine-grained tweaks live in each machine's menu. Changes apply when you save."
          status={
            grantsDirty
              ? "Unsaved changes"
              : `${Object.keys(savedGrants).length} machine${Object.keys(savedGrants).length === 1 ? "" : "s"} on`
          }
          control={
            grantsDirty ? (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setMcpGatewayGrants(pendingGrants);
                    setSavedGrants(pendingGrants);
                    setPendingGrants(null);
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPendingGrants(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : undefined
          }
        >
          <McpEnvironmentGrantMatrix
            environments={environmentRows}
            grants={pendingGrants ?? savedGrants}
            onChange={setPendingGrants}
          />
        </SettingsRow>
        <SettingsRow
          id="mcp-gateway-profiles"
          title="Named profiles"
          description="Save provider, model, and execution defaults for MCP-created threads. Profiles store readable selections; routing details are resolved at thread creation. Later edits never mutate existing work."
        >
          <McpProfileList
            profiles={profiles}
            providers={providers}
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
