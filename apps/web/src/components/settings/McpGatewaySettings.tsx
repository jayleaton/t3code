import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import {
  resolveGatewayProfileModelSelection,
  type GatewayScope,
  type GatewayStatusSnapshot,
} from "@t3tools/client-runtime/gateway";
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
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
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
  getMcpGatewayStatus,
  getMcpGatewayStatusSnapshot,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  MCP_GATEWAY_BASELINE_SCOPES,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
  MCP_GATEWAY_STATE_EVENT,
  requestMcpGatewayStatusSnapshot,
  type McpGatewayGrants,
  type McpGatewayUiState,
  setMcpGatewayEnabled,
  setMcpGatewayGrants,
  setMcpGatewayToken,
  subscribeMcpGatewayConfiguration,
} from "../../mcpGatewayState";

/**
 * Least-privilege scopes applied by the machine-level `On` baseline. The
 * per-machine menu exposes the full v3 contract separately so additional
 * authority is never granted implicitly.
 */
const SCOPE_LABELS: Record<GatewayScope, string> = {
  read: "Read environments and threads",
  create: "Create threads",
  send: "Send messages",
  control: "Control active work",
  lifecycle: "Pause, retry, and restart work",
  approval: "Review and decide approvals",
  artifact: "Retrieve thread artifacts",
  review: "Read and update code reviews",
  admin: "Change repositories and access",
  delivery: "Manage subscriptions and webhooks",
};

const UNSELECTED_PROVIDER = "—";

const ADVANCED_SCOPES = MCP_GATEWAY_CONFIGURABLE_SCOPES.filter(
  (scope) => !MCP_GATEWAY_BASELINE_SCOPES.includes(scope),
);

export interface McpGrantEnvironmentRow {
  readonly environmentId: string;
  readonly label: string;
  readonly connectionState: string;
  readonly failureReason?: EnvironmentConnectionPresentation["failureReason"];
}

function deviceConnectionText(environment: McpGrantEnvironmentRow): string {
  if (environment.connectionState === "connected") return "Connected";
  // Typed failure categories avoid copying tokens, URLs, or raw decoder payloads into Settings.
  const failure = (() => {
    switch (environment.failureReason) {
      case "authentication":
        return "Authentication failed — reconnect or sign in in Settings → Connections.";
      case "permission":
        return "Connection permission denied — review access in Settings → Connections.";
      case "unsupported":
        return "Incompatible connection — check client and server compatibility in Settings → Connections.";
      case "configuration":
        return "Connection configuration failed — review Settings → Connections.";
      case "transport":
        return "Transport failed — check the remote server and connection route.";
      case "timeout":
        return "Connection timed out — check the remote server and connection route.";
      case "network":
        return "Network unavailable — check network connectivity.";
      case "relay-unavailable":
        return "Relay unavailable — check T3 Connect in Settings → Connections.";
      case "endpoint-unavailable":
      case "remote-unavailable":
        return "Remote unavailable — check the remote server and connection route.";
      default:
        return null;
    }
  })();
  const phase = (() => {
    switch (environment.connectionState) {
      case "connecting":
        return "Connecting";
      case "reconnecting":
        return "Reconnecting";
      case "offline":
        return "Disconnected — device or network offline";
      case "available":
        return "Disconnected — connect in Settings → Connections";
      case "error":
        return "Connection failed — see Settings → Connections";
      default:
        return "Unavailable — no current runtime connection";
    }
  })();
  return failure ? `${phase}. ${failure}` : phase;
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
    else if (!isGrantOn(grants, environment.environmentId)) {
      next[environment.environmentId] = [...MCP_GATEWAY_BASELINE_SCOPES];
    }
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
  registryReady = true,
}: {
  readonly registryReady?: boolean;
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

  if (!registryReady) {
    return (
      <p className="text-sm text-muted-foreground">
        Device connection status unavailable — loading the runtime registry.
      </p>
    );
  }

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
      <p className="text-sm" aria-live="polite">
        {environments.filter((environment) => environment.connectionState === "connected").length}{" "}
        of {environments.length} registered devices connected. Access grants do not connect devices.
      </p>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allOn}
            indeterminate={!allOn && anyOn}
            aria-label="Enable all environments"
            onCheckedChange={selectAll}
          />
          Enable all environments
        </label>
        <span className="text-xs text-muted-foreground">
          {allOn
            ? "Access on for all listed machines"
            : anyOn
              ? "Mixed selection of access grants"
              : "Access off for all listed machines"}
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
                <div className="text-xs" aria-live="polite">
                  {deviceConnectionText(environment)}
                </div>
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
                  <span className="min-w-0 truncate">{on ? "Access on" : "Access off"}</span>
                  <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
                </MenuTrigger>
                <MenuPopup align="end" className="w-56">
                  <MenuRadioGroup
                    value={
                      MCP_GATEWAY_CONFIGURABLE_SCOPES.every((scope) => scopes.includes(scope))
                        ? "all"
                        : on
                          ? "on"
                          : "off"
                    }
                    onValueChange={(value) => {
                      onChange(
                        setEnvironmentScopes(
                          grants,
                          environment.environmentId,
                          value === "all"
                            ? MCP_GATEWAY_CONFIGURABLE_SCOPES
                            : value === "on"
                              ? MCP_GATEWAY_BASELINE_SCOPES
                              : [],
                        ),
                      );
                    }}
                  >
                    <MenuRadioItem value="off">Off</MenuRadioItem>
                    <MenuRadioItem value="on">On (default access)</MenuRadioItem>
                    <MenuRadioItem value="all">All capabilities</MenuRadioItem>
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Default capabilities</MenuGroupLabel>
                    {MCP_GATEWAY_BASELINE_SCOPES.map((scope: GatewayScope) => (
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
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Additional capabilities (grant explicitly)</MenuGroupLabel>
                    {ADVANCED_SCOPES.map((scope: GatewayScope) => (
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
                        {SCOPE_LABELS[scope]}
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

export function McpGatewayOperationalStatus({
  state,
  snapshot,
  labels = {},
  environments = [],
  grants = {},
  onRefresh,
}: {
  readonly state: McpGatewayUiState;
  readonly snapshot: GatewayStatusSnapshot | null;
  readonly labels?: Readonly<Record<string, string>>;
  readonly environments?: ReadonlyArray<McpGrantEnvironmentRow>;
  readonly grants?: McpGatewayGrants;
  readonly onRefresh: () => void;
}) {
  const disconnected = state === "disabled" || state === "degraded";
  const readableEnvironments =
    snapshot?.environments.filter((environment) =>
      scopesFor(grants, environment.environmentId).includes("read"),
    ) ?? [];
  return (
    <div className="space-y-3" aria-label="MCP gateway operational status">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Operational status</div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={state !== "running"}>
          Refresh
        </Button>
      </div>
      <p className="text-sm" aria-live="polite">
        Local gateway bridge:{" "}
        {state === "running"
          ? "Connected"
          : state === "connecting"
            ? "Connecting"
            : state === "disabled"
              ? "Disabled"
              : "Disconnected"}
        . This does not indicate device connectivity.
      </p>
      {disconnected ? (
        <p className="text-sm text-muted-foreground">
          {state === "disabled" ? "Gateway disabled." : "Gateway disconnected or degraded."}
        </p>
      ) : snapshot === null || state === "connecting" ? (
        <p className="text-sm text-muted-foreground">Loading operational status…</p>
      ) : !snapshot.live || snapshot.stale ? (
        <p className="text-sm text-destructive">
          Status is stale; live sidecar data is unavailable.
        </p>
      ) : readableEnvironments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No readable environments are currently granted.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Event store as of {snapshot.capturedAt}; this does not indicate device connectivity.
            Retention: {snapshot.retention.maxEventsPerEnvironment} events per environment for{" "}
            {snapshot.retention.maxAgeDays} days.
          </p>
          {readableEnvironments.map((environment) => (
            <div key={environment.environmentId} className="rounded-lg border p-3 text-sm">
              <div className="font-medium">
                {labels[environment.environmentId] ?? "Environment"}
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {environment.environmentId}
              </div>
              <div className="mt-2 text-xs">
                Device:{" "}
                {deviceConnectionText(
                  environments.find((row) => row.environmentId === environment.environmentId) ?? {
                    environmentId: environment.environmentId,
                    label: "Environment",
                    connectionState: "unavailable",
                  },
                )}
              </div>
              <div className="mt-2 text-xs">
                Cursor {environment.latestSequence}; retained {environment.retainedEventCount};
                oldest {environment.oldestRetainedSequence ?? "none"}
              </div>
              {!environment.deliveryAccess ||
              !scopesFor(grants, environment.environmentId).includes("delivery") ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  Delivery permission needed to view subscriptions, webhooks, and queue health.
                </div>
              ) : (
                <div className="mt-2 space-y-2 text-xs">
                  <div>
                    Delivery queue: {environment.deliveries?.pending ?? 0} pending,{" "}
                    {environment.deliveries?.inFlight ?? 0} in flight,{" "}
                    {environment.deliveries?.acked ?? 0} acknowledged,{" "}
                    {environment.deliveries?.failed ?? 0} failed;{" "}
                    {environment.deliveryFailureCount ?? 0} recorded failures.
                  </div>
                  <div>
                    Subscriptions ({environment.subscriptionCount ?? 0})
                    {environment.subscriptionsTruncated ? " — first 100 shown" : ""}
                  </div>
                  {(environment.subscriptions ?? []).length === 0 ? (
                    <div className="text-muted-foreground">No subscriptions.</div>
                  ) : (
                    (environment.subscriptions ?? []).map((subscription) => (
                      <div
                        key={subscription.subscriptionId}
                        className="rounded border px-2 py-1 font-mono"
                      >
                        {subscription.subscriptionId} — {subscription.status}; cursor{" "}
                        {subscription.ackedSequence}; {subscription.pendingEventCount} pending
                      </div>
                    ))
                  )}
                  <div>
                    Webhooks ({environment.webhookCount ?? 0})
                    {environment.webhooksTruncated ? " — first 100 shown" : ""}
                  </div>
                  {(environment.webhooks ?? []).length === 0 ? (
                    <div className="text-muted-foreground">No webhooks.</div>
                  ) : (
                    (environment.webhooks ?? []).map((webhook) => (
                      <div key={webhook.webhookId} className="rounded border px-2 py-1 font-mono">
                        {webhook.webhookId} — {webhook.status}; cursor {webhook.ackedSequence};{" "}
                        {webhook.deliveries.pending} pending, {webhook.deliveries.failed} failed
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

interface ProfileDraft {
  readonly systemPrompt: string;
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
  systemPrompt: "",
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
      models:
        provider.status === "ready"
          ? provider.models.map((model) => ({ slug: model.slug, name: model.name }))
          : [],
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
  catalogConnected = true,
  onChange,
}: {
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly catalogConnected?: boolean;
  readonly onChange: (profiles: ReadonlyArray<McpGatewayProfile>) => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const providerEntries = useMemo(
    () => (catalogConnected ? deriveProfileProviderEntries(providers) : []),
    [providers, catalogConnected],
  );
  const selectedEntry =
    draft.instanceId === null
      ? undefined
      : providerEntries.find((entry) => entry.instanceId === draft.instanceId);
  const existing =
    editingProfileId === null
      ? undefined
      : profiles.find((profile) => profile.profileId === editingProfileId);

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT);
    setEditingProfileId(null);
  };

  const startEdit = (profile: McpGatewayProfile) => {
    setEditingProfileId(profile.profileId);
    const selection = catalogConnected
      ? resolveGatewayProfileModelSelection(profile, providers)
      : undefined;
    const entry = providerEntries.find(
      (candidate) => candidate.instanceId === selection?.instanceId,
    );
    const model = selection?.model ?? null;
    setDraft({
      name: profile.name,
      systemPrompt: profile.systemPrompt ?? "",
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
    editingProfileId !== null &&
    existing !== undefined &&
    (selectedEntry === undefined ||
      draft.model === null ||
      (existing.providerLabel !== undefined && existing.providerLabel !== selectedEntry.label) ||
      (existing.modelLabel !== undefined &&
        existing.modelLabel !==
          selectedEntry.models.find((candidate) => candidate.slug === draft.model)?.name));

  const duplicateName = profiles.some(
    (profile) => profile.profileId !== editingProfileId && profile.name === draft.name.trim(),
  );
  const selectedModel = selectedEntry?.models.find((model) => model.slug === draft.model);
  const draftSelection =
    selectedEntry === undefined || selectedModel === undefined
      ? undefined
      : resolveGatewayProfileModelSelection(
          { providerLabel: selectedEntry.label, modelLabel: selectedModel.name },
          providers,
        );
  const ambiguousSelection = selectedModel !== undefined && draftSelection === undefined;
  const canSave =
    draft.name.trim() !== "" &&
    !duplicateName &&
    selectedEntry?.isReady === true &&
    draftSelection?.instanceId === selectedEntry.instanceId &&
    draftSelection.model === draft.model;

  return (
    <div className="space-y-3">
      {profiles.map((profile) => {
        const unavailable =
          !catalogConnected ||
          resolveGatewayProfileModelSelection(profile, providers) === undefined;
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

      <label className="grid gap-2 text-sm">
        System prompt
        <textarea
          className="min-h-28 rounded-md border p-3"
          maxLength={32000}
          value={draft.systemPrompt}
          onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
          placeholder="Agent role, workflow, and expected output"
        />
      </label>
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
                <SelectItem
                  key={entry.instanceId}
                  value={entry.instanceId}
                  disabled={!entry.isReady}
                >
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
          disabled={selectedEntry?.isReady !== true}
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
      {ambiguousSelection ? (
        <p className="text-xs text-destructive" role="note">
          Multiple providers or models share these names. Choose a provider and model with a unique
          name combination before saving.
        </p>
      ) : null}
      {duplicateName ? (
        <p className="text-xs text-destructive" role="note">
          A profile named {draft.name.trim()} already exists.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={!canSave}
          onClick={() => {
            const entry = selectedEntry;
            const model = entry?.models.find((candidate) => candidate.slug === draft.model);
            if (!canSave || entry === undefined || model === undefined) return;
            const now = new globalThis.Date().toISOString();
            const name = draft.name.trim();
            // The edited profile is tracked by its stable profileId, never
            // by name — renaming must not orphan the original row or mint a
            // fresh identity (spec §9.1: renames keep profileId and history).
            const previous = existing;
            if (
              profiles.some(
                (candidate) =>
                  candidate.profileId !== previous?.profileId && candidate.name === name,
              )
            ) {
              return;
            }
            // Persist readable labels only. The instance/model routing keys
            // stay in this draft — they are never serialized into the
            // profile (spec §9.2).
            const profile: McpGatewayProfile = {
              profileId: previous?.profileId ?? `profile_${randomUUID()}`,
              name,
              systemPrompt: draft.systemPrompt,
              ...(previous?.color ? { color: previous.color } : {}),
              ...(previous?.icon ? { icon: previous.icon } : {}),
              ...(previous?.environmentIds ? { environmentIds: previous.environmentIds } : {}),
              providerLabel: entry.label,
              modelLabel: model.name,
              ...(draft.reasoningEffort === null ? {} : { reasoningEffort: draft.reasoningEffort }),
              runtimeMode: draft.runtimeMode,
              interactionMode: previous?.interactionMode ?? "default",
              // Required wire fields are placeholders on create and preserved
              // on edit; the server assigns revision and timestamps.
              revision: previous?.revision ?? 1,
              createdAt: previous?.createdAt ?? now,
              updatedAt: previous?.updatedAt ?? now,
            };
            onChange([
              ...profiles.filter((candidate) => candidate.profileId !== previous?.profileId),
              profile,
            ]);
            resetDraft();
          }}
        >
          {editingProfileId === null ? "Save profile" : `Update ${existing?.name ?? "profile"}`}
        </Button>
        {editingProfileId !== null || draft !== EMPTY_DRAFT ? (
          <Button variant="ghost" onClick={resetDraft}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function McpGatewaySettings() {
  const { environments, isReady: registryReady } = useEnvironments();
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [token, setToken] = useState(getMcpGatewayToken);
  const [savedGrants, setSavedGrants] = useState(getMcpGatewayGrants);
  const [pendingGrants, setPendingGrants] = useState<McpGatewayGrants | null>(null);
  const profiles = usePrimarySettings((settings) => settings.mcpGatewayProfiles);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const updatePrimarySettings = useUpdatePrimarySettings();
  const [status, setStatus] = useState<McpGatewayUiState>(() =>
    enabled ? getMcpGatewayStatus() : "disabled",
  );
  const [statusSnapshot, setStatusSnapshot] = useState(getMcpGatewayStatusSnapshot);

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<McpGatewayUiState>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
  }, []);

  useEffect(() => {
    const onSnapshot = (event: Event) =>
      setStatusSnapshot((event as CustomEvent<GatewayStatusSnapshot | null>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onSnapshot);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onSnapshot);
  }, []);

  useEffect(() => {
    let saved = JSON.stringify(getMcpGatewayGrants());
    return subscribeMcpGatewayConfiguration(() => {
      setEnabled(isMcpGatewayEnabled());
      setToken(getMcpGatewayToken());
      const next = getMcpGatewayGrants();
      const serialized = JSON.stringify(next);
      if (serialized !== saved) {
        saved = serialized;
        setSavedGrants(next);
        // Discard a stale draft so saving cannot restore another window's revoked grants.
        setPendingGrants(null);
      }
    });
  }, []);

  const grantsDirty =
    pendingGrants !== null && JSON.stringify(pendingGrants) !== JSON.stringify(savedGrants);

  const environmentRows: ReadonlyArray<McpGrantEnvironmentRow> = environments.map(
    (environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connectionState: environment.connection.phase,
      failureReason: environment.connection.failureReason,
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
              : `${Object.keys(savedGrants).length} machine${Object.keys(savedGrants).length === 1 ? "" : "s"} with access grants`
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
            registryReady={registryReady}
            grants={pendingGrants ?? savedGrants}
            onChange={setPendingGrants}
          />
        </SettingsRow>
        <SettingsRow
          id="mcp-gateway-operational-status"
          title="Events and delivery"
          description="Live event retention, cursors, subscriptions, webhooks, and delivery queue health from the authenticated local companion."
        >
          <McpGatewayOperationalStatus
            state={status}
            snapshot={statusSnapshot}
            environments={environmentRows}
            grants={savedGrants}
            labels={Object.fromEntries(
              environmentRows.map((row) => [row.environmentId, row.label]),
            )}
            onRefresh={() => {
              requestMcpGatewayStatusSnapshot();
            }}
          />
        </SettingsRow>
        <SettingsRow
          id="mcp-gateway-profiles"
          title="Named profiles"
          description="Save provider, model, and execution defaults for MCP-created threads. This editor uses the primary environment’s connected provider catalog. Profiles store readable selections; routing details are resolved on the target environment at thread creation. Later edits never mutate existing work."
        >
          <McpProfileList
            profiles={profiles}
            providers={providers}
            catalogConnected={primaryEnvironment?.connection.phase === "connected"}
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
