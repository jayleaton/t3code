import {
  VoiceAssistantController,
  type VoiceAssistantState,
  type VoiceConversationPort,
} from "@t3tools/client-runtime/voice-assistant";
import {
  createGatewayRuntimePortFromContext,
  type GatewayRuntimePort,
} from "@t3tools/client-runtime/gateway";
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
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
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

/**
 * Owns the live voice runtime for the whole client.
 *
 * Microphone capture is deliberately independent of provider credentials: the
 * user must be able to verify their input device (level meter, device picker)
 * before any key exists. The Gemini Live conversation attaches separately once
 * a credential is available, through a mutable proxy the controller already
 * holds, so arming the mic never tears down capture.
 */
export function VoiceAssistantHostProvider({ children }: { readonly children: ReactNode }) {
  const mode = useClientSettings((settings) => settings.voiceAssistantMode);
  const provider = useClientSettings((settings) => settings.voiceConversationProvider);
  const timeout = useClientSettings((settings) => settings.voiceSilenceTimeoutSeconds);
  const shortcut = useClientSettings((settings) => settings.voicePushToTalkShortcut);
  const deviceId = useClientSettings((settings) => settings.voiceMicrophoneDeviceId);
  const agentProfileId = useClientSettings((settings) => settings.voiceAgentProfileId);
  const agentThreadId = useClientSettings((settings) => settings.voiceAgentThreadId);
  const updateSettings = useUpdateClientSettings();
  const environmentId = usePrimaryEnvironmentId();
  const runtime = useAtomValue(connectionAtomRuntime);
  const { profiles } = useAgentLibrary();
  const projects = useProjects();
  const credential = useEnvironmentQuery(
    environmentId === null || mode === "off"
      ? null
      : voiceAssistantEnvironment.liveSessionCredential({ environmentId, input: { provider } }),
  );
  const credentialToken = credential.data?.token ?? null;
  const credentialModel = credential.data?.model ?? null;

  const [state, setState] = useState<VoiceAssistantState>(OFF_STATE);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneStatus>("off");
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<VoiceAssistantController | null>(null);
  const captureRef = useRef<MicrophoneCapture | null>(null);
  const conversationRef = useRef<VoiceConversationPort | null>(null);
  const playbackRef = useRef<ReturnType<typeof createSpeakerPlayback> | null>(null);
  const testTimerRef = useRef<number | null>(null);

  // The controller holds this proxy for its whole life; attaching or detaching
  // the real Gemini session mutates the ref instead of rebuilding the mic.
  const conversationProxy = useRef<VoiceConversationPort>({
    connect: () => conversationRef.current?.connect() ?? Promise.resolve(),
    disconnect: () => conversationRef.current?.disconnect() ?? Promise.resolve(),
    sendAudio: (chunk) => conversationRef.current?.sendAudio(chunk),
    sendText: (text) => conversationRef.current?.sendText(text),
    finalizeInput: () => conversationRef.current?.finalizeInput(),
    cancel: () => conversationRef.current?.cancel(),
  });

  // Live values the tool executor needs, kept in a ref so the executor is built
  // once (preserving its "last task" memory) while still seeing current state.
  const toolDepsRef = useRef({
    runtime,
    environmentId,
    profiles,
    projects,
    agentProfileId,
    agentThreadId,
    updateSettings,
  });
  toolDepsRef.current = {
    runtime,
    environmentId,
    profiles,
    projects,
    agentProfileId,
    agentThreadId,
    updateSettings,
  };
  const toolHandler = useMemo(
    () =>
      createVoiceToolHandler({
        getPort: (): GatewayRuntimePort | null => {
          const value = toolDepsRef.current.runtime;
          return value._tag === "Success" ? createGatewayRuntimePortFromContext(value.value) : null;
        },
        getEnvironmentId: () => toolDepsRef.current.environmentId,
        getProfile: () =>
          toolDepsRef.current.profiles.find(
            (profile) => profile.profileId === toolDepsRef.current.agentProfileId,
          ) ?? null,
        resolveProjectId: () =>
          toolDepsRef.current.projects.find(
            (project) => project.environmentId === toolDepsRef.current.environmentId,
          )?.id ?? null,
        getThreadId: () =>
          toolDepsRef.current.agentThreadId.length > 0 ? toolDepsRef.current.agentThreadId : null,
        storeThreadId: (threadId) => {
          void toolDepsRef.current.updateSettings({ voiceAgentThreadId: threadId });
        },
        newThreadId,
        newMessageId,
        newRequestId: randomUUID,
      }),
    [],
  );

  const requestMicrophoneAccess = useCallback(() => {
    setMicrophoneStatus((current) => (current === "off" ? "starting" : current));
    void captureRef.current
      ?.start()
      .then(() => setMicrophoneStatus("live"))
      .catch((cause: unknown) => {
        setMicrophoneStatus("error");
        setError(cause instanceof Error ? cause.message : "Microphone capture failed to start.");
      });
    void captureRef.current?.resume();
  }, []);

  const testMicrophone = useCallback(() => {
    requestMicrophoneAccess();
    const capture = captureRef.current;
    if (capture === null) return;
    void capture.beginUtterance().then(() => setMicrophoneActive(true));
    if (testTimerRef.current !== null) {
      window.clearTimeout(testTimerRef.current);
    }
    testTimerRef.current = window.setTimeout(() => {
      testTimerRef.current = null;
      setMicrophoneActive(false);
      void capture.endUtterance();
    }, TEST_MICROPHONE_MS);
  }, [requestMicrophoneAccess]);

  // Microphone + controller runtime, independent of any provider credential.
  useEffect(() => {
    if (mode === "off") {
      setState(OFF_STATE);
      setMicrophoneStatus("off");
      setMicrophoneActive(false);
      setMicrophoneLevel(0);
      return;
    }
    const playback = createSpeakerPlayback();
    playbackRef.current = playback;
    const capture = createMicrophoneCapture({
      ...(deviceId.length > 0 ? { deviceId } : {}),
      onFrame: (frame) => conversationProxy.current.sendAudio(frame),
      onLevel: (level) => setMicrophoneLevel(level),
      onError: (cause) => {
        setError(cause.message);
        setMicrophoneStatus("error");
      },
    });
    const controller = new VoiceAssistantController({
      ports: {
        capture,
        conversation: conversationProxy.current,
        playback: { stop: async () => playback.stop() },
      },
      conversationProvider: provider,
      silenceTimeoutSeconds: timeout,
      onStateChange: setState,
    });
    controllerRef.current = controller;
    captureRef.current = capture;
    setError(null);
    setMicrophoneStatus("starting");
    void capture
      .start()
      .then(() => setMicrophoneStatus("live"))
      .catch((cause: unknown) => {
        setMicrophoneStatus("error");
        setError(cause instanceof Error ? cause.message : "Microphone capture failed to start.");
      });
    void controller.setMode(mode);

    return () => {
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
        testTimerRef.current = null;
      }
      controllerRef.current = null;
      captureRef.current = null;
      playbackRef.current = null;
      setMicrophoneActive(false);
      setMicrophoneLevel(0);
      playback.dispose();
      void controller.dispose();
    };
  }, [mode, provider, timeout, deviceId]);

  // Gemini Live session, attached only when a credential exists.
  useEffect(() => {
    if (mode === "off" || credentialToken === null || credentialModel === null) {
      const existing = conversationRef.current;
      conversationRef.current = null;
      void existing?.disconnect();
      return;
    }
    const conversation = new GeminiLiveConversation({
      apiKey: credentialToken,
      model: credentialModel,
      systemInstruction: VOICE_SYSTEM_INSTRUCTION,
      ...(agentProfileId.trim().length > 0 ? { tools: VOICE_TOOL_DECLARATIONS } : {}),
      createSocket: (url) => new WebSocket(url) as unknown as GeminiLiveSocket,
      callbacks: {
        onOpen: () => controllerRef.current?.setTransport("ready"),
        onClose: (event) => {
          controllerRef.current?.setTransport("disconnected");
          // Surface an abnormal close (bad key, unknown model, quota) instead of
          // silently showing "Disconnected".
          if (event.code !== 1000 && event.code !== 1005) {
            setError(
              `Voice session closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`,
            );
          }
        },
        onError: (cause) => {
          setError(cause.message);
          controllerRef.current?.setTransport("failed");
        },
        onAudio: (chunk) => {
          // First model audio of the turn flips the indicator from Thinking to
          // Speaking, so the user can tell it heard them.
          controllerRef.current?.handleAssistantSpeechStart();
          playbackRef.current?.enqueue(chunk);
        },
        onInputTranscript: (text) => controllerRef.current?.handleFinalTranscript(text),
        onTurnComplete: () => controllerRef.current?.handleAssistantSpeechEnd(),
        onInterrupted: () => controllerRef.current?.handleAssistantSpeechEnd(),
        onToolCall: (call) => {
          // Delegated work runs on the local agent (MCP/workspace tools); the
          // result is returned to the model, which speaks a short summary.
          void toolHandler(call)
            .then((result) => conversation.sendToolResponse(call.id, result))
            .catch((cause: unknown) =>
              conversation.sendToolResponse(call.id, {
                error: cause instanceof Error ? cause.message : "Tool execution failed.",
              }),
            );
        },
      },
    });
    conversationRef.current = conversation;
    void conversation.connect().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not open the voice session.");
    });
    return () => {
      if (conversationRef.current === conversation) {
        conversationRef.current = null;
      }
      void conversation.disconnect();
    };
  }, [mode, credentialToken, credentialModel, agentProfileId, toolHandler]);

  // Browsers suspend an AudioContext created without a gesture; resume it on the
  // first interaction so capture produces frames even before a hotkey press.
  useEffect(() => {
    const resume = () => {
      void captureRef.current?.resume();
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, []);

  useEffect(() => {
    if (mode === "off") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        controllerRef.current?.cancel();
        return;
      }
      if (event.repeat || isTypingTarget(event.target)) return;
      if (shortcut.trim().length === 0 || !matchesVoiceShortcut(event, shortcut)) return;
      // Capture-phase, and stop propagation so a focused button cannot treat
      // the key as a Space/Enter activation and open the dialog.
      event.preventDefault();
      event.stopPropagation();
      void captureRef.current?.resume();
      void controllerRef.current?.pressPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shortcut.trim().length === 0 || !matchesVoiceShortcut(event, shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      void controllerRef.current?.releasePushToTalk();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [mode, shortcut]);

  return (
    <VoiceAssistantHostContext.Provider
      value={{
        state,
        microphoneLevel,
        microphoneStatus,
        microphoneActive,
        error,
        environmentId,
        hasLiveCredential: credentialToken !== null,
        requestMicrophoneAccess,
        testMicrophone,
      }}
    >
      {children}
      <VoiceAssistantIndicator />
    </VoiceAssistantHostContext.Provider>
  );
}
