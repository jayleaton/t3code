import {
  VoiceAssistantController,
  type VoiceAssistantState,
} from "@t3tools/client-runtime/voice-assistant";
import { createVoiceExecutionPort } from "@t3tools/client-runtime/voice-assistant";
import { useVoiceDevice } from "./useVoiceDevice";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomValue } from "@effect/atom-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAgentLibrary } from "../hooks/useAgentLibrary";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { randomUUID } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { voiceAssistantEnvironment } from "../state/voiceAssistant";
import { createMicrophoneCapture, type MicrophoneCapture } from "./audio/microphoneCapture";
import { createSpeakerPlayback } from "./audio/speakerPlayback";
import { GeminiLiveConversation, type GeminiLiveSocket } from "./geminiLiveConversation";
import { VoiceAssistantIndicator } from "./VoiceAssistantIndicator";
import { matchesVoiceShortcut } from "./pushToTalkShortcut";
import {
  createVoiceToolHandler,
  VOICE_SYSTEM_INSTRUCTION,
  VOICE_TOOL_DECLARATIONS,
} from "./voiceTools";
import { summarizeVoiceValue, voiceTranscript } from "./voiceTranscriptStore";

const OFF_STATE: VoiceAssistantState = {
  mode: "off",
  input: "off",
  output: "idle",
  transport: "disconnected",
  microphone: "released",
  conversationProvider: "gemini",
  silenceTimeoutSeconds: 5,
  transcript: "",
  partialTranscript: "",
  lastAnnouncement: null,
  lastError: null,
  sessionGeneration: 0,
};

export type MicrophoneStatus = "off" | "starting" | "live" | "error";

export interface VoiceAssistantHostValue {
  readonly state: VoiceAssistantState;
  readonly microphoneLevel: number;
  readonly microphoneStatus: MicrophoneStatus;
  readonly microphoneActive: boolean;
  readonly error: string | null;
  readonly environmentId: string | null;
  readonly hasLiveCredential: boolean;
  /** Acquires/updates the microphone from a user gesture (device picker). */
  readonly requestMicrophoneAccess: () => void;
  /** Opens the mic gate for a few seconds so the level meter can prove input. */
  readonly testMicrophone: () => void;
  readonly pressPushToTalk: () => void;
  readonly releasePushToTalk: () => void;
  readonly cancel: () => void;
  readonly shortcutStatus: string;
}

const VoiceAssistantHostContext = createContext<VoiceAssistantHostValue>({
  state: OFF_STATE,
  microphoneLevel: 0,
  microphoneStatus: "off",
  microphoneActive: false,
  error: null,
  environmentId: null,
  hasLiveCredential: false,
  requestMicrophoneAccess: () => undefined,
  testMicrophone: () => undefined,
  pressPushToTalk: () => undefined,
  releasePushToTalk: () => undefined,
  cancel: () => undefined,
  shortcutStatus: "Hold-to-talk works while this browser is focused.",
});

export function useVoiceAssistantHost(): VoiceAssistantHostValue {
  return useContext(VoiceAssistantHostContext);
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-keybinding-capture]") !== null) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
};

const TEST_MICROPHONE_MS = 4000;

/** Owns one session per selected voice environment, agent, and input device. */
export function VoiceAssistantHostProvider({ children }: { readonly children: ReactNode }) {
  const settings = useClientSettings();
  const mode = settings.voiceAssistantMode === "wake-word" ? "off" : settings.voiceAssistantMode;
  const provider = settings.voiceConversationProvider;
  const environmentId = useVoiceDevice();
  const credentialEnvironmentId = usePrimaryEnvironmentId();
  const runtime = useAtomValue(connectionAtomRuntime);
  const { profiles } = useAgentLibrary();
  const updateSettings = useUpdateClientSettings();
  const credential = useEnvironmentQuery(
    credentialEnvironmentId === null || mode === "off"
      ? null
      : voiceAssistantEnvironment.liveSessionCredential({
          environmentId: credentialEnvironmentId,
          input: { provider },
        }),
  );
  const token = credential.error === null ? (credential.data?.token ?? null) : null;
  const model = credential.data?.model ?? null;
  const [state, setState] = useState<VoiceAssistantState>(OFF_STATE);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState(
    "Hold-to-talk works while this browser is focused.",
  );
  const globalShortcut = useRef(false);
  const controllerRef = useRef<VoiceAssistantController | null>(null);
  const captureRef = useRef<MicrophoneCapture | null>(null);
  const playbackRef = useRef<ReturnType<typeof createSpeakerPlayback> | null>(null);
  const testTimerRef = useRef<number | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const previousThread = useRef(settings.voiceAgentSessionId);
  useEffect(() => {
    if (previousThread.current && !settings.voiceAgentSessionId)
      setResetVersion((value) => value + 1);
    previousThread.current = settings.voiceAgentSessionId;
  }, [settings.voiceAgentSessionId]);

  const live = useRef({ settings, runtime, profiles, environmentId, updateSettings });
  live.current = { settings, runtime, profiles, environmentId, updateSettings };

  useEffect(() => {
    setState(OFF_STATE);
    setError(null);
    setTesting(false);
    setMicrophoneLevel(0);
    if (mode === "off" || token === null || model === null) return;
    let disposed = false;
    let providerFinished = false;
    let turnNumber = 0;
    const sessionId = randomUUID();
    const toolHandler = createVoiceToolHandler({
      getPort: () => {
        const { runtime: value, environmentId: deviceId } = live.current;
        return value._tag === "Success" && deviceId
          ? createVoiceExecutionPort(value.value, deviceId)
          : null;
      },
      getProfile: () =>
        live.current.profiles.find(
          (p) => p.profileId === live.current.settings.voiceAgentProfileId,
        ) ?? null,
      getSessionId: () => live.current.settings.voiceAgentSessionId || null,
      storeSessionId: (threadId) => {
        live.current = {
          ...live.current,
          settings: { ...live.current.settings, voiceAgentSessionId: threadId },
        };
        void live.current.updateSettings({ voiceAgentSessionId: threadId });
      },
      newSessionId: randomUUID,
    });
    const fail = (cause: unknown) => {
      if (disposed) return;
      controller.cancel();
      controller.setTransport("failed");
      setError(cause instanceof Error ? cause.message : "Voice session failed.");
    };
    const playback = createSpeakerPlayback({
      onDrained: () => {
        if (!disposed && providerFinished) controller.handleAssistantSpeechEnd();
      },
    });
    const capture = createMicrophoneCapture({
      ...(settings.voiceMicrophoneDeviceId ? { deviceId: settings.voiceMicrophoneDeviceId } : {}),
      onFrame: (frame) => {
        if (!disposed && controller.getState().input === "capturing") conversation.sendAudio(frame);
      },
      onLevel: (level) => {
        if (!disposed) setMicrophoneLevel(level);
      },
      onError: fail,
    });
    const conversation = new GeminiLiveConversation({
      apiKey: token,
      model,
      systemInstruction: VOICE_SYSTEM_INSTRUCTION,
      ...(settings.voiceAgentProfileId ? { tools: VOICE_TOOL_DECLARATIONS } : {}),
      createSocket: (url) => new WebSocket(url) as unknown as GeminiLiveSocket,
      callbacks: {
        onOpen: () => {
          if (!disposed) {
            controller.setTransport("ready");
            setError(null);
          }
        },
        onClose: (event) => {
          if (!disposed)
            fail(new Error(event.reason || "Voice disconnected. Press push-to-talk to reconnect."));
        },
        onError: fail,
        onAudio: (chunk) => {
          if (disposed || controller.getState().input === "capturing") return;
          providerFinished = false;
          controller.handleAssistantSpeechStart();
          playback.enqueue(chunk);
        },
        onInputTranscript: (text) => {
          if (disposed) return;
          voiceTranscript.upsert(`${sessionId}-user-${turnNumber}`, "user", text);
          controller.handleFinalTranscript(text);
        },
        onOutputTranscript: (text) => {
          if (!disposed)
            voiceTranscript.upsert(`${sessionId}-assistant-${turnNumber}`, "assistant", text);
        },
        onTurnComplete: () => {
          if (disposed) return;
          turnNumber += 1;
          providerFinished = true;
          if (!playback.speaking) controller.handleAssistantSpeechEnd();
        },
        onInterrupted: () => {
          playback.stop();
          providerFinished = true;
          if (!disposed) controller.handleAssistantSpeechEnd();
        },
        onToolCall: (call, signal) => {
          if (disposed || signal.aborted) return;
          voiceTranscript.push("tool", `${call.name} ${summarizeVoiceValue(call.args)}`);
          void toolHandler(call, signal)
            .then((result) => {
              if (disposed || signal.aborted) return;
              voiceTranscript.push("tool", `→ ${summarizeVoiceValue(result)}`);
              conversation.sendToolResponse(call.id, result);
            })
            .catch((cause: unknown) => {
              if (!disposed && !signal.aborted)
                conversation.sendToolResponse(call.id, { error: String(cause) });
            });
        },
      },
    });
    const controller = new VoiceAssistantController({
      ports: { capture, conversation, playback: { stop: async () => playback.stop() } },
      conversationProvider: provider,
      silenceTimeoutSeconds: 5,
      onStateChange: (value) => {
        if (!disposed) setState(value);
      },
    });
    controllerRef.current = controller;
    captureRef.current = capture;
    playbackRef.current = playback;
    void controller
      .setMode(mode)
      .then(() => {
        if (disposed) return;
        controller.setTransport("connecting");
        return conversation.connect();
      })
      .catch(fail);
    return () => {
      disposed = true;
      if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
      controllerRef.current = null;
      captureRef.current = null;
      playbackRef.current = null;
      playback.dispose();
      void controller.dispose();
    };
  }, [
    mode,
    provider,
    token,
    model,
    environmentId,
    credentialEnvironmentId,
    settings.voiceMicrophoneDeviceId,
    settings.voiceAgentProfileId,
    resetVersion,
  ]);

  const execution = useEnvironmentQuery(
    environmentId && settings.voiceAgentSessionId
      ? voiceAssistantEnvironment.execution({
          environmentId,
          input: { sessionId: settings.voiceAgentSessionId },
        })
      : null,
  );
  const lastAgentEvent = useRef<string | null>(null);
  useEffect(() => {
    const state = execution.data;
    if (!state) {
      lastAgentEvent.current = null;
      return;
    }
    const identity = `${environmentId}:${state.sessionId}:${state.revision}:${state.status}`;
    if (lastAgentEvent.current === identity) return;
    lastAgentEvent.current = identity;
    if (
      state.status === "approval"
        ? !settings.voiceAnnounceApprovals
        : state.status === "input"
          ? !settings.voiceAnnounceInputRequests
          : !settings.voiceAnnounceCompletions
    )
      return;
    if (!["completed", "failed", "approval", "input"].includes(state.status)) return;
    controllerRef.current?.announce(
      `The device task is now ${state.status}. Call get_voice_task_status and briefly explain the result or pending approval.`,
    );
  }, [
    execution.data,
    environmentId,
    settings.voiceAnnounceApprovals,
    settings.voiceAnnounceCompletions,
    settings.voiceAnnounceInputRequests,
  ]);

  // Resetting a conversation closes its provider process and MCP credentials.
  useEffect(() => {
    if (!environmentId || !settings.voiceAgentSessionId || runtime._tag !== "Success") return;
    const port = createVoiceExecutionPort(runtime.value, environmentId);
    const sessionId = settings.voiceAgentSessionId;
    return () => {
      void port({ action: "close", sessionId }).catch(() => undefined);
    };
  }, [environmentId, settings.voiceAgentSessionId, runtime]);

  const testMicrophone = useCallback(() => {
    const capture = captureRef.current;
    if (capture === null || controllerRef.current?.getState().input !== "standby") return;
    if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
    setTesting(true);
    // A microphone test only measures locally; it never opens the upload gate.
    void capture.start().catch((cause: unknown) => {
      setError(String(cause));
      setTesting(false);
    });
    testTimerRef.current = window.setTimeout(() => {
      testTimerRef.current = null;
      setTesting(false);
      void capture.endUtterance();
    }, TEST_MICROPHONE_MS);
  }, []);

  const pressPushToTalk = useCallback(() => {
    if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
    testTimerRef.current = null;
    setTesting(false);
    setError(null);
    void playbackRef.current?.resume().catch((cause: unknown) => setError(String(cause)));
    void controllerRef.current?.pressPushToTalk();
  }, []);
  const releasePushToTalk = useCallback(() => {
    void controllerRef.current?.releasePushToTalk();
  }, []);
  const cancel = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.configureVoiceShortcut || !bridge.onVoiceShortcut) return;
    let active = true;
    const unsubscribe = bridge.onVoiceShortcut((phase) => {
      if (!active) return;
      if (phase === "down") {
        if (document.activeElement?.closest("[data-keybinding-capture]")) return;
        pressPushToTalk();
      } else if (phase === "up") releasePushToTalk();
      else {
        globalShortcut.current = false;
        cancel();
        setShortcutStatus(
          "Global voice shortcut stopped. Use the in-app shortcut or re-enable voice.",
        );
      }
    });
    void bridge
      .configureVoiceShortcut(mode === "off" ? null : settings.voicePushToTalkShortcut || null)
      .then((result) => {
        if (!active) return;
        globalShortcut.current = result.registered;
        setShortcutStatus(result.message);
      })
      .catch((cause: unknown) => {
        if (active) setShortcutStatus(String(cause));
      });
    return () => {
      active = false;
      globalShortcut.current = false;
      unsubscribe();
      void bridge.configureVoiceShortcut?.(null);
    };
  }, [mode, settings.voicePushToTalkShortcut, pressPushToTalk, releasePushToTalk, cancel]);

  useEffect(() => {
    if (mode === "off") return;
    let heldCode: string | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        heldCode = null;
        cancel();
        return;
      }
      if (
        globalShortcut.current ||
        event.repeat ||
        heldCode !== null ||
        isTypingTarget(event.target)
      )
        return;
      if (!matchesVoiceShortcut(event, settings.voicePushToTalkShortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      heldCode = event.code || event.key;
      pressPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // Modifier release order must not leave the microphone stuck open.
      if (
        heldCode === null ||
        ((event.code || event.key) !== heldCode &&
          !["Alt", "Meta", "Control", "Shift"].includes(event.key))
      )
        return;
      event.preventDefault();
      heldCode = null;
      releasePushToTalk();
    };
    const onBlur = () => {
      if (heldCode !== null) {
        heldCode = null;
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      onBlur();
    };
  }, [mode, settings.voicePushToTalkShortcut, pressPushToTalk, releasePushToTalk, cancel]);

  const value = useMemo<VoiceAssistantHostValue>(
    () => ({
      state,
      microphoneLevel,
      microphoneStatus: testing || state.input === "capturing" ? "live" : "off",
      microphoneActive: testing || state.input === "capturing",
      error: error ?? state.lastError ?? credential.error,
      environmentId,
      hasLiveCredential: token !== null,
      requestMicrophoneAccess: testMicrophone,
      testMicrophone,
      pressPushToTalk,
      releasePushToTalk,
      cancel,
      shortcutStatus,
    }),
    [
      state,
      microphoneLevel,
      testing,
      error,
      credential.error,
      environmentId,
      token,
      testMicrophone,
      pressPushToTalk,
      releasePushToTalk,
      cancel,
      shortcutStatus,
    ],
  );
  return (
    <VoiceAssistantHostContext.Provider value={value}>
      {children}
      <VoiceAssistantIndicator />
    </VoiceAssistantHostContext.Provider>
  );
}
