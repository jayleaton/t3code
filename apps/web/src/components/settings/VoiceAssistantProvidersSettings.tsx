import {
  type EnvironmentId,
  VOICE_PROVIDER_LABELS,
  type VoiceProviderConfigSnapshot,
  type VoiceProviderKeyStatus,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Trash2Icon } from "lucide-react";

import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceAssistantEnvironment } from "../../state/voiceAssistant";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const STORAGE_EXPLANATION =
  "Keys are stored in the selected environment's secret store (server-side), never in browser storage, chat settings, transcripts, or logs.";

const statusBadge = (status: VoiceProviderKeyStatus) => {
  if (status.implementation === "planned") {
    return <Badge variant="warning">Not available yet</Badge>;
  }
  return status.configured ? (
    <Badge variant="success">Configured</Badge>
  ) : (
    <Badge variant="outline">Not configured</Badge>
  );
};

const testSummary = (status: VoiceProviderKeyStatus): string | null => {
  switch (status.lastTest.status) {
    case "succeeded":
      return status.lastTest.latencyMs === null
        ? "Last connection test succeeded."
        : `Last connection test succeeded in ${status.lastTest.latencyMs} ms.`;
    case "failed":
      return status.lastTest.message ?? "Last connection test failed.";
    case "unavailable":
      return status.lastTest.message ?? "This provider is not available yet.";
    default:
      return null;
  }
};

function ProviderKeyRow({
  environmentId,
  environmentLabel,
  status,
  onRefresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly status: VoiceProviderKeyStatus;
  readonly onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [pending, setPending] = useState<"save" | "test" | "remove" | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [message, setMessage] = useState<{
    readonly tone: "error" | "info";
    readonly text: string;
  } | null>(null);

  const setProviderKey = useAtomCommand(voiceAssistantEnvironment.setProviderKey, {
    reportFailure: false,
  });
  const removeProviderKey = useAtomCommand(voiceAssistantEnvironment.removeProviderKey, {
    reportFailure: false,
  });
  const testProviderKey = useAtomCommand(voiceAssistantEnvironment.testProviderKey, {
    reportFailure: false,
  });

  const isPlanned = status.implementation === "planned";

  const run = async (
    kind: "save" | "test" | "remove",
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    successMessage: string,
  ) => {
    setPending(kind);
    setMessage(null);
    try {
      const result = await action();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setMessage({
            tone: "error",
            text: failure instanceof Error ? failure.message : "The request failed. Try again.",
          });
        }
        return false;
      }
      setMessage({ tone: "info", text: successMessage });
      onRefresh();
      return true;
    } catch {
      setMessage({ tone: "error", text: "The request failed. Try again." });
      return false;
    } finally {
      setPending(null);
    }
  };

  const save = async () => {
    const apiKey = keyDraft.trim();
    if (apiKey.length === 0) {
      setMessage({ tone: "error", text: "Enter an API key first." });
      return;
    }
    if (!isPlanned) {
      // Validate the candidate before committing it, so a bad replacement
      // never overwrites a working key.
      setPending("save");
      setMessage(null);
      const validation = await testProviderKey({
        environmentId,
        input: { providerId: status.providerId, apiKey },
      });
      setPending(null);
      if (validation._tag === "Failure") {
        const failure = squashAtomCommandFailure(validation);
        setMessage({
          tone: "error",
          text: failure instanceof Error ? failure.message : "Could not validate this key.",
        });
        return;
      }
      const candidate = validation.value.providers.find(
        (entry) => entry.providerId === status.providerId,
      );
      if (candidate !== undefined && candidate.lastTest.status === "failed") {
        setMessage({
          tone: "error",
          text: candidate.lastTest.message ?? "The provider rejected this key.",
        });
        return;
      }
    }
    const ok = await run(
      "save",
      () =>
        setProviderKey({
          environmentId,
          input: { providerId: status.providerId, apiKey },
        }),
      `${VOICE_PROVIDER_LABELS[status.providerId]} key saved.`,
    );
    if (ok) {
      setEditing(false);
      setKeyDraft("");
    }
  };

  const summary = testSummary(status);
  const configuredHint =
    status.configured && status.keyHint !== null ? `Key ${status.keyHint}` : null;

  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-2">
          {status.label}
          {statusBadge(status)}
        </span>
      }
      description={
        <span className="space-y-1">
          <span className="block">
            {isPlanned
              ? "Stored for when the adapter ships. It never looks functional before then."
              : `Used for ${status.role === "decision" ? "narrow routing decisions" : "speech conversations"}.`}{" "}
            {STORAGE_EXPLANATION}
          </span>
          {status.role === "decision" ? (
            <span className="block">
              Optional. Without it, exact-target commands and completion announcements still work.
            </span>
          ) : null}
          {configuredHint ? <span className="block">{configuredHint}</span> : null}
          {summary ? <span className="block">{summary}</span> : null}
          {message ? (
            <span
              className={
                message.tone === "error" ? "block text-destructive" : "block text-muted-foreground"
              }
            >
              {message.text}
            </span>
          ) : null}
          <span className="block">
            Stored in <span className="text-foreground/80">{environmentLabel}</span> (
            {environmentId}).
          </span>
        </span>
      }
      control={
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          {editing ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(true);
                setRemoveArmed(false);
                setMessage(null);
              }}
            >
              {status.configured ? "Replace key" : "Add key"}
            </Button>
          )}
          {!isPlanned && status.configured ? (
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={pending !== null}
              onClick={() =>
                void run(
                  "test",
                  () =>
                    testProviderKey({ environmentId, input: { providerId: status.providerId } }),
                  "Connection test finished.",
                )
              }
            >
              {pending === "test" ? "Testing..." : "Test connection"}
            </Button>
          ) : null}
          {status.configured ? (
            <Button
              size="icon-sm"
              variant={removeArmed ? "destructive" : "ghost-muted"}
              aria-label={
                removeArmed ? `Confirm removing ${status.label} key` : `Remove ${status.label} key`
              }
              disabled={pending !== null}
              onClick={() => {
                if (!removeArmed) {
                  setRemoveArmed(true);
                  setMessage({ tone: "info", text: "Press remove again to confirm." });
                  return;
                }
                setRemoveArmed(false);
                void run(
                  "remove",
                  () =>
                    removeProviderKey({
                      environmentId,
                      input: { providerId: status.providerId },
                    }),
                  `${status.label} key removed. Dependent sessions are closed.`,
                );
              }}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </span>
      }
    >
      {editing ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            type="password"
            autoComplete="off"
            size="sm"
            className="w-full sm:w-72"
            placeholder={`${status.label} API key`}
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            aria-label={`${status.label} API key`}
          />
          <Button size="sm" disabled={pending !== null} onClick={() => void save()}>
            {pending === "save" ? "Validating..." : "Save key"}
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={pending !== null}
            onClick={() => {
              setEditing(false);
              setKeyDraft("");
              setMessage(null);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function VoiceProviderKeys({
  environmentId,
  environmentLabel,
  snapshot,
  refresh,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly snapshot: VoiceProviderConfigSnapshot | null;
  readonly refresh: () => void;
}) {
  if (snapshot === null) {
    return null;
  }
  return (
    <>
      {snapshot.providers.map((status) => (
        <ProviderKeyRow
          key={status.providerId}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          status={status}
          onRefresh={refresh}
        />
      ))}
    </>
  );
}

export function VoiceAssistantProvidersSection() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = selectedEnvironmentId ?? primaryEnvironmentId;

  const conversationProvider = useScopedSettings((settings) => settings.voiceConversationProvider);
  const updateSettings = useUpdateScopedSettings();

  const selectedEnvironment = useMemo(
    () => environments.find((environment) => environment.environmentId === environmentId) ?? null,
    [environmentId, environments],
  );
  const environmentLabel = selectedEnvironment?.label ?? environmentId ?? "no environment";

  const config = useEnvironmentQuery(
    environmentId === null
      ? null
      : voiceAssistantEnvironment.providerConfig({ environmentId, input: {} }),
  );

  return (
    <SettingsSection id="voice-assistant" title="Voice assistant">
      <SettingsRow
        {...searchableSetting("voice-conversation-provider")}
        description="Which live speech provider the assistant connects to. OpenAI voice is planned and cannot be selected yet."
        control={
          <Select
            value={conversationProvider}
            onValueChange={(value) => {
              if (value === "gemini") {
                updateSettings({ voiceConversationProvider: value });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-56"
              aria-label="Voice conversation provider"
            >
              <SelectValue>{VOICE_PROVIDER_LABELS[conversationProvider]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="gemini">
                {VOICE_PROVIDER_LABELS.gemini}
              </SelectItem>
              <SelectItem hideIndicator value="openai" disabled>
                {VOICE_PROVIDER_LABELS.openai} (not available yet)
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Credential owner"
        description="Choose which environment stores the voice provider keys. This is independent of the agent environment selected in chat."
        control={
          <Select
            value={environmentId}
            onValueChange={(value) => setSelectedEnvironmentId(value as EnvironmentId | null)}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-64"
              aria-label="Voice credential environment"
            >
              <SelectValue>
                {environmentId === null ? "No environment" : environmentLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {environments.map((environment) => (
                <SelectItem
                  key={environment.environmentId}
                  hideIndicator
                  value={environment.environmentId}
                >
                  {environment.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {environmentId === null ? (
        <SettingsRow
          title="No environment connected"
          description="Connect an environment before saving voice provider keys."
        />
      ) : config.error !== null ? (
        <SettingsRow title="Could not read credentials" description={config.error} />
      ) : (
        <VoiceProviderKeys
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          snapshot={config.data}
          refresh={config.refresh}
        />
      )}
    </SettingsSection>
  );
}
