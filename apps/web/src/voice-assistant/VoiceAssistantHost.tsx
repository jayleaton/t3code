import {
  VoiceAssistantController,
  type VoiceAssistantState,
} from "@t3tools/client-runtime/voice-assistant";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useClientSettings } from "../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { voiceAssistantEnvironment } from "../state/voiceAssistant";
import { createMicrophoneCapture, type MicrophoneCapture } from "./audio/microphoneCapture";
import { createSpeakerPlayback } from "./audio/speakerPlayback";
import { GeminiLiveConversation, type GeminiLiveSocket } from "./geminiLiveConversation";
import { matchesVoiceShortcut } from "./pushToTalkShortcut";

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

export interface VoiceAssistantHostValue {
  readonly state: VoiceAssistantState;
  readonly microphoneLevel: number;
  readonly error: string | null;
  readonly environmentId: string | null;
  /** Acquires/updates the microphone from a user gesture (device picker). */
  readonly requestMicrophoneAccess: () => void;
}

const VoiceAssistantHostContext = createContext<VoiceAssistantHostValue>({
  state: OFF_STATE,
  microphoneLevel: 0,
  error: null,
  environmentId: null,
  requestMicrophoneAccess: () => undefined,
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

/**
 * Owns the live voice runtime for the whole client: it acquires the microphone,
 * opens one Gemini Live session when a mode is armed and a credential is
 * available, and routes the push-to-talk hotkey. Mounted once at the app root
 * so voice works while the user is elsewhere in the app.
 */
export function VoiceAssistantHostProvider({ children }: { readonly children: ReactNode }) {
  const mode = useClientSettings((settings) => settings.voiceAssistantMode);
  const provider = useClientSettings((settings) => settings.voiceConversationProvider);
  const timeout = useClientSettings((settings) => settings.voiceSilenceTimeoutSeconds);
  const shortcut = useClientSettings((settings) => settings.voicePushToTalkShortcut);
  const deviceId = useClientSettings((settings) => settings.voiceMicrophoneDeviceId);
  const environmentId = usePrimaryEnvironmentId();
  const credential = useEnvironmentQuery(
    environmentId === null || mode === "off"
      ? null
      : voiceAssistantEnvironment.liveSessionCredential({
          environmentId,
          input: { provider },
        }),
  );
  const credentialToken = credential.data?.token ?? null;
  const credentialModel = credential.data?.model ?? null;

  const [state, setState] = useState<VoiceAssistantState>(OFF_STATE);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<VoiceAssistantController | null>(null);
  const captureRef = useRef<MicrophoneCapture | null>(null);

  useEffect(() => {
    if (mode === "off" || credentialToken === null || credentialModel === null) {
      return;
    }
    const playback = createSpeakerPlayback();
    let controller: VoiceAssistantController | null = null;
    const conversation = new GeminiLiveConversation({
      apiKey: credentialToken,
      model: credentialModel,
      createSocket: (url) => new WebSocket(url) as unknown as GeminiLiveSocket,
      callbacks: {
        onOpen: () => controller?.setTransport("ready"),
        onClose: () => controller?.setTransport("disconnected"),
        onError: (cause) => {
          setError(cause.message);
          controller?.setTransport("failed");
        },
        onAudio: (chunk) => playback.enqueue(chunk),
        onInputTranscript: (text) => controller?.handleFinalTranscript(text),
        onTurnComplete: () => controller?.handleAssistantSpeechEnd(),
        onInterrupted: () => controller?.handleAssistantSpeechEnd(),
      },
    });
    const capture = createMicrophoneCapture({
      ...(deviceId.length > 0 ? { deviceId } : {}),
      onFrame: (frame) => conversation.sendAudio(frame),
      onLevel: setMicrophoneLevel,
      onError: (cause) => setError(cause.message),
    });
    controller = new VoiceAssistantController({
      ports: {
        capture,
        conversation,
        playback: { stop: async () => playback.stop() },
      },
      conversationProvider: provider,
      silenceTimeoutSeconds: timeout,
      onStateChange: setState,
    });
    controllerRef.current = controller;
    captureRef.current = capture;
    setError(null);

    void conversation.connect();
    void capture.start().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Microphone capture failed to start.");
    });
    void controller.setMode(mode);

    return () => {
      controllerRef.current = null;
      captureRef.current = null;
      playback.dispose();
      void controller?.dispose();
    };
  }, [mode, provider, timeout, credentialToken, credentialModel, deviceId]);

  useEffect(() => {
    if (mode === "off") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        controllerRef.current?.cancel();
        return;
      }
      if (event.repeat || isTypingTarget(event.target)) return;
      if (shortcut.trim().length === 0 || !matchesVoiceShortcut(event, shortcut)) return;
      event.preventDefault();
      // First press is a user gesture: make sure the mic/audio context exist and
      // are resumed (browsers start an AudioContext suspended until a gesture).
      void captureRef.current?.start().catch(() => undefined);
      void captureRef.current?.resume();
      void controllerRef.current?.pressPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (shortcut.trim().length === 0 || !matchesVoiceShortcut(event, shortcut)) return;
      void controllerRef.current?.releasePushToTalk();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [mode, shortcut]);

  const requestMicrophoneAccess = useCallback(() => {
    void captureRef.current?.start().catch(() => undefined);
    void captureRef.current?.resume();
  }, []);

  return (
    <VoiceAssistantHostContext.Provider
      value={{ state, microphoneLevel, error, environmentId, requestMicrophoneAccess }}
    >
      {children}
    </VoiceAssistantHostContext.Provider>
  );
}
