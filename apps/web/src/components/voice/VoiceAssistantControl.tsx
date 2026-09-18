import { VOICE_PROVIDER_LABELS, type VoiceAssistantMode } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AudioLines, Mic, MicOff, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { useVoiceDevice } from "../../voice-assistant/useVoiceDevice";
import { usePrimaryEnvironmentId, useEnvironment } from "../../state/environments";
import { connectPairing } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { isLoopbackVoiceUrl } from "../../voice-assistant/localDevice";
import { Input } from "../ui/input";
import { useEnvironmentQuery } from "../../state/query";
import { voiceAssistantEnvironment } from "../../state/voiceAssistant";
import {
  captureVoiceShortcut,
  formatVoiceShortcut,
  matchesVoiceShortcut,
} from "../../voice-assistant/pushToTalkShortcut";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useVoiceAssistantHost } from "../../voice-assistant/VoiceAssistantHost";
import { voiceTranscript } from "../../voice-assistant/voiceTranscriptStore";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { SidebarMenuButton } from "../ui/sidebar";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const MODE_LABELS: Readonly<Record<VoiceAssistantMode, string>> = {
  off: "Off",
  "push-to-talk": "Push-to-talk",
  "wake-word": "Hey agent",
};

const MODE_OPTIONS: ReadonlyArray<VoiceAssistantMode> = ["off", "push-to-talk"];

const modeIcon = (mode: VoiceAssistantMode) => {
  if (mode === "off") return <MicOff aria-hidden="true" />;
  if (mode === "wake-word") return <AudioLines aria-hidden="true" />;
  return <Mic aria-hidden="true" />;
};

function PushToTalkShortcutRecorder() {
  const value = useClientSettings((settings) => settings.voicePushToTalkShortcut);
  const update = useUpdateClientSettings();
  const [recording, setRecording] = useState(false);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording || event.repeat) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    const result = captureVoiceShortcut(event.nativeEvent);
    if (result.kind === "ignore") return;
    setRecording(false);
    if (result.kind === "cancel") return;
    if (result.kind === "clear") {
      update({ voicePushToTalkShortcut: "" });
      return;
    }
    update({ voicePushToTalkShortcut: result.value });
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-foreground">Push-to-talk key</div>
        <div className="text-xs leading-relaxed text-muted-foreground">
          Hold this key to talk. Press Escape to cancel, Backspace to clear.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          variant={recording ? "secondary" : "outline"}
          aria-pressed={recording}
          aria-label={`Push-to-talk shortcut: ${
            recording ? "recording, press a key" : formatVoiceShortcut(value)
          }`}
          data-keybinding-capture=""
          onFocus={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          onClick={() => setRecording(true)}
          onKeyDown={onKeyDown}
        >
          {recording ? "Press a key…" : formatVoiceShortcut(value)}
        </Button>
        {value.trim().length > 0 ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Clear push-to-talk key"
            onClick={() => update({ voicePushToTalkShortcut: "" })}
          >
            <XIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Confirms the recorded chord actually matches a live key press. This is a
 * binding test, not audio capture: it proves the shortcut will drive the host
 * once the live engine lands.
 */
function HotkeyTestRow() {
  const value = useClientSettings((settings) => settings.voicePushToTalkShortcut);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (value.trim().length === 0) {
      setHeld(false);
      return;
    }
    const fromRecorder = (event: KeyboardEvent) =>
      event.target instanceof Element && event.target.closest("[data-keybinding-capture]") !== null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (fromRecorder(event) || !matchesVoiceShortcut(event, value)) return;
      event.preventDefault();
      setHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (fromRecorder(event) || !matchesVoiceShortcut(event, value)) return;
      setHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [value]);

  if (value.trim().length === 0) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">Test your shortcut</span>
      <span className={held ? "text-foreground" : "text-muted-foreground"}>
        {held ? "Detected — holding" : "Press the key to test"}
      </span>
    </div>
  );
}

const TRANSPORT_LABELS = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  failed: "Failed",
} as const;

function LiveStatusBlock() {
  const {
    state,
    microphoneLevel,
    microphoneStatus,
    microphoneActive,
    error,
    hasLiveCredential,
    testMicrophone,
    shortcutStatus,
  } = useVoiceAssistantHost();
  const shortcut = useClientSettings((settings) => settings.voicePushToTalkShortcut);

  const micStatusLabel =
    microphoneStatus === "live"
      ? "Microphone active"
      : microphoneStatus === "starting"
        ? "Starting microphone…"
        : microphoneStatus === "error"
          ? "Microphone unavailable"
          : state.mode !== "off"
            ? "Ready — hold to talk"
            : "Microphone off";

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Microphone</span>
        <Badge variant={microphoneStatus === "live" ? "success" : "outline"}>
          {micStatusLabel}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <Mic className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-100"
            style={{ width: `${Math.round(microphoneLevel * 100)}%` }}
          />
        </div>
        <Button type="button" size="xs" variant="outline" onClick={testMicrophone}>
          Test mic
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Live session</span>
        <Badge
          variant={
            state.transport === "ready"
              ? "success"
              : state.transport === "failed"
                ? "error"
                : "outline"
          }
        >
          {TRANSPORT_LABELS[state.transport]}
        </Badge>
      </div>
      {microphoneActive || state.input === "capturing" ? (
        <p className="text-xs text-foreground">Listening… speak now.</p>
      ) : shortcut.trim().length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Hold {formatVoiceShortcut(shortcut)} to talk.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Set a push-to-talk key to talk.</p>
      )}
      {state.mode !== "off" && !hasLiveCredential ? (
        <p className="text-xs text-warning-foreground">
          Voice is armed but no Gemini API key is available for this environment, so replies cannot
          be spoken yet.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{shortcutStatus}</p>
      {state.transcript ? (
        <p className="text-xs text-muted-foreground">Last request: “{state.transcript}”</p>
      ) : null}
      {state.lastAnnouncement ? (
        <p className="text-xs text-muted-foreground">
          Last announcement: “{state.lastAnnouncement}”
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function MicrophoneRow() {
  const deviceId = useClientSettings((settings) => settings.voiceMicrophoneDeviceId);
  const update = useUpdateClientSettings();
  const { requestMicrophoneAccess } = useVoiceAssistantHost();
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);

  const refresh = useCallback(() => {
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices === undefined || typeof mediaDevices.enumerateDevices !== "function") return;
    void mediaDevices
      .enumerateDevices()
      .then((all) => setDevices(all.filter((device) => device.kind === "audioinput")))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices === undefined) return;
    mediaDevices.addEventListener("devicechange", refresh);
    return () => mediaDevices.removeEventListener("devicechange", refresh);
  }, [refresh]);

  const labelsHidden = devices.length > 0 && devices.every((device) => device.label.length === 0);
  const selectedLabel =
    deviceId.length === 0
      ? "System default"
      : devices.find((device) => device.deviceId === deviceId)?.label || "Selected microphone";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-foreground">Microphone</div>
          <div className="text-xs text-muted-foreground">The input device voice listens to.</div>
        </div>
        <Select
          value={deviceId.length === 0 ? "default" : deviceId}
          onValueChange={(value) =>
            update({ voiceMicrophoneDeviceId: value === null || value === "default" ? "" : value })
          }
        >
          <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="Microphone">
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="default">
              System default
            </SelectItem>
            {devices.map((device, index) => (
              <SelectItem
                key={device.deviceId || `device-${index}`}
                hideIndicator
                value={device.deviceId || `device-${index}`}
              >
                {device.label || `Microphone ${index + 1}`}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {labelsHidden ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="w-full"
          onClick={() => {
            requestMicrophoneAccess();
            window.setTimeout(refresh, 700);
          }}
        >
          Allow microphone access to see device names
        </Button>
      ) : null}
    </div>
  );
}

function VoiceAgentRow() {
  const profileId = useClientSettings((settings) => settings.voiceAgentProfileId);
  const sessionId = useClientSettings((settings) => settings.voiceAgentSessionId);
  const update = useUpdateClientSettings();
  const { profiles } = useAgentLibrary();
  const selected = profiles.find((profile) => profile.profileId === profileId) ?? null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-foreground">Voice agent</div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            Tasks run on this device in a dedicated conversation. The agent uses its machine tools
            and T3 MCP across projects.
          </div>
        </div>
        <Select
          value={profileId.length === 0 ? "none" : profileId}
          onValueChange={(value) =>
            update({
              voiceAgentProfileId: value === null || value === "none" ? "" : value,
              // A different agent must not inherit the previous one's session.
              voiceAgentSessionId: "",
            })
          }
        >
          <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="Voice agent">
            <SelectValue>{selected?.name ?? "Conversation only"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="none">
              Conversation only
            </SelectItem>
            {profiles.map((profile) => (
              <SelectItem key={profile.profileId} hideIndicator value={profile.profileId}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {selected === null && profileId.length > 0 ? (
        <p className="text-xs text-warning-foreground">
          The selected agent is no longer available in this environment.
        </p>
      ) : null}
      {sessionId.length > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="w-full"
          onClick={() => {
            update({ voiceAgentSessionId: "" });
            voiceTranscript.clear();
          }}
        >
          Start a new voice conversation
        </Button>
      ) : null}
    </div>
  );
}

function ModeRow() {
  const navigate = useNavigate();
  const mode = useClientSettings((settings) => settings.voiceAssistantMode);
  const conversationProvider = useClientSettings((settings) => settings.voiceConversationProvider);
  const update = useUpdateClientSettings();
  const environmentId = usePrimaryEnvironmentId();
  const config = useEnvironmentQuery(
    environmentId === null
      ? null
      : voiceAssistantEnvironment.providerConfig({ environmentId, input: {} }),
  );
  const providerStatus = config.data?.providers.find(
    (entry) => entry.providerId === conversationProvider,
  );
  const providerReady =
    providerStatus !== undefined &&
    providerStatus.implementation !== "planned" &&
    providerStatus.configured;

  const selectMode = (next: VoiceAssistantMode) => {
    update({ voiceAssistantMode: next });
    if (next !== "off" && providerStatus !== undefined && !providerReady) {
      void navigate({ to: "/settings/general", hash: "voice-assistant" });
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5">
        {MODE_OPTIONS.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={mode === option ? "default" : "outline"}
            onClick={() => selectMode(option)}
          >
            {MODE_LABELS[option]}
          </Button>
        ))}
      </div>
      {mode === "wake-word" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Hey agent keeps the microphone active locally for wake detection only — nothing is
          uploaded until the wake phrase is detected.
        </p>
      ) : null}
      {mode !== "off" && providerStatus !== undefined && !providerReady ? (
        <div className="flex items-center justify-between gap-2 rounded-md bg-warning/8 p-2 text-[11px] text-warning-foreground">
          <span>Add a {VOICE_PROVIDER_LABELS[conversationProvider]} API key to connect voice.</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/general", hash: "voice-assistant" })}
          >
            Set up
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function VoiceDestinationRow() {
  const environmentId = useVoiceDevice();
  const environment = useEnvironment(environmentId);
  const pair = useAtomCommand(connectPairing);
  const [showPairing, setShowPairing] = useState(false);
  const [pairingUrl, setPairingUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const connect = async () => {
    if (!isLoopbackVoiceUrl(pairingUrl.trim())) {
      setMessage(
        "Use a pairing URL beginning with http://localhost or http://127.0.0.1 from T3 on this device.",
      );
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const result = await pair({ pairingUrl: pairingUrl.trim() });
      if (result._tag === "Success") {
        setPairingUrl("");
        setShowPairing(false);
        setMessage(
          "Paired. If the executor does not appear, update the local T3 instance to a version with voice execution support.",
        );
      } else
        setMessage(
          "Could not pair with local T3. Check the pairing link and allow local network access in your browser.",
        );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <p>
        {environmentId
          ? `Device executor: ${environment?.label ?? "Connected"}. Tasks run here, independently of the project you are viewing.`
          : "Voice is connected, but device execution is not. Pair with an updated T3 instance running on this computer."}
      </p>
      {!environmentId ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setShowPairing((value) => !value)}
          >
            {showPairing ? "Cancel" : "Connect this device"}
          </Button>
          {showPairing ? (
            <div className="space-y-2">
              <p>
                Copy a local pairing link from T3 on this computer. Use its localhost address, and
                allow local network access if your browser asks. This connection is saved only in
                this browser.
              </p>
              <Input
                aria-label="Local T3 pairing URL"
                type="password"
                autoComplete="off"
                value={pairingUrl}
                onChange={(event) => setPairingUrl(event.target.value)}
                placeholder="http://localhost:3773/pair#token=…"
              />
              <Button
                type="button"
                size="xs"
                disabled={pending || !pairingUrl.trim()}
                onClick={() => void connect()}
              >
                {pending ? "Connecting…" : "Pair local T3"}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  );
}

function TalkButton() {
  const { state, pressPushToTalk, releasePushToTalk, cancel, hasLiveCredential } =
    useVoiceAssistantHost();
  return (
    <Button
      type="button"
      className="w-full"
      disabled={state.mode === "off" || !hasLiveCredential}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pressPushToTalk();
      }}
      onPointerUp={releasePushToTalk}
      onPointerCancel={cancel}
      onLostPointerCapture={releasePushToTalk}
      onKeyDown={(event) => {
        if (!event.repeat && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          pressPushToTalk();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          releasePushToTalk();
        }
      }}
    >
      {state.input === "capturing" ? "Release to send" : "Hold to talk"}
    </Button>
  );
}

function AnnouncementRow({
  label,
  description,
  settingKey,
}: {
  readonly label: string;
  readonly description: string;
  readonly settingKey:
    | "voiceAnnounceCompletions"
    | "voiceAnnounceInputRequests"
    | "voiceAnnounceApprovals";
}) {
  const enabled = useClientSettings((settings) => settings[settingKey]);
  const update = useUpdateClientSettings();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(checked) => {
          const next = Boolean(checked);
          if (settingKey === "voiceAnnounceCompletions") {
            update({ voiceAnnounceCompletions: next });
          } else if (settingKey === "voiceAnnounceInputRequests") {
            update({ voiceAnnounceInputRequests: next });
          } else {
            update({ voiceAnnounceApprovals: next });
          }
        }}
        aria-label={label}
      />
    </div>
  );
}

function VoiceAssistantDialogContent() {
  const navigate = useNavigate();
  const conversationProvider = useClientSettings((settings) => settings.voiceConversationProvider);
  const environmentId = usePrimaryEnvironmentId();
  const config = useEnvironmentQuery(
    environmentId === null
      ? null
      : voiceAssistantEnvironment.providerConfig({ environmentId, input: {} }),
  );
  const providerStatus = config.data?.providers.find(
    (entry) => entry.providerId === conversationProvider,
  );

  return (
    <DialogPopup className="w-full sm:w-[30rem]">
      <DialogHeader>
        <DialogTitle>Voice assistant</DialogTitle>
        <DialogDescription>
          Choose how the assistant listens and speaks. Credentials are stored in the connected
          environment.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <ModeRow />
        <LiveStatusBlock />
        <MicrophoneRow />
        <VoiceDestinationRow />
        <VoiceAgentRow />
        <TalkButton />
        <PushToTalkShortcutRecorder />
        <HotkeyTestRow />

        <div className="space-y-3 border-t border-border/50 pt-3">
          <AnnouncementRow
            label="Speak completions"
            description="Announce when a device task finishes or fails."
            settingKey="voiceAnnounceCompletions"
          />
          <AnnouncementRow
            label="Speak requests for input"
            description="Announce when an agent is waiting for an answer."
            settingKey="voiceAnnounceInputRequests"
          />
          <AnnouncementRow
            label="Speak approval requests"
            description="Announce when an agent needs approval to continue."
            settingKey="voiceAnnounceApprovals"
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
          <div className="min-w-0">
            <div className="text-sm text-foreground">
              {VOICE_PROVIDER_LABELS[conversationProvider]}
            </div>
            <div className="text-xs text-muted-foreground">
              {providerStatus?.configured ? "API key configured." : "No API key configured yet."}
            </div>
          </div>
          <Badge variant={providerStatus?.configured ? "success" : "outline"}>
            {providerStatus?.configured ? "Ready" : "Setup needed"}
          </Badge>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Push-to-talk captures, sends, and plays back audio through the selected provider. The “Hey
          agent” wake engine is the next milestone; until then push-to-talk is the way to talk.
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/general", hash: "voice-assistant" })}
        >
          Provider settings
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function VoiceAssistantDialogTrigger({ trigger }: { readonly trigger: ReactElement }) {
  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <VoiceAssistantDialogContent />
    </Dialog>
  );
}

/** Sidebar footer entry point (inside the sidebar menu context). */
export function VoiceAssistantControl() {
  const settings = useClientSettings((value) => value.voiceAssistantMode);
  return (
    <VoiceAssistantDialogTrigger
      trigger={
        <SidebarMenuButton
          aria-label={`Voice assistant: ${MODE_LABELS[settings]}`}
          size="icon"
          className={settings === "off" ? undefined : "text-foreground"}
          onKeyDown={(event) => {
            // The push-to-talk chord is often Space-based; never let Space
            // activate this trigger and open the dialog.
            if (event.key === " " || event.key === "Spacebar") event.preventDefault();
          }}
        >
          {modeIcon(settings)}
        </SidebarMenuButton>
      }
    />
  );
}

/** Plain icon trigger for surfaces without the sidebar menu context. */
export function VoiceAssistantIconButton({ className }: { readonly className?: string }) {
  const settings = useClientSettings((value) => value.voiceAssistantMode);
  return (
    <VoiceAssistantDialogTrigger
      trigger={
        <Button
          type="button"
          aria-label={`Voice assistant: ${MODE_LABELS[settings]}`}
          size="icon-xs"
          variant={settings === "off" ? "outline" : "default"}
          className={className}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "Spacebar") event.preventDefault();
          }}
        >
          {modeIcon(settings)}
        </Button>
      }
    />
  );
}
