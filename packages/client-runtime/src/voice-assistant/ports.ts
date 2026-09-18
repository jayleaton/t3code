import type {
  VoiceAssistantMode,
  VoiceConversationProvider,
  VoiceSilenceTimeoutSeconds,
} from "@t3tools/contracts";

/**
 * Input, output, and transport are deliberately separate dimensions so the
 * assistant can announce agent events while input is idle, and so a transport
 * reconnect never implies the microphone is open.
 */
export type VoiceInputPhase =
  | "off"
  | "standby"
  | "verifying"
  | "capturing"
  | "finalizing"
  | "unavailable";

export type VoiceOutputPhase = "idle" | "preparing" | "speaking";

export type VoiceTransportPhase =
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "failed";

/**
 * Physical microphone state, kept distinct from the logical input phase. Wake
 * mode keeps the microphone capturing locally for detection; push-to-talk and
 * off release it. The UI must never describe wake standby as "mic off".
 */
export type VoiceMicrophoneState = "released" | "wake-listening" | "streaming";

export interface VoiceAssistantState {
  readonly mode: VoiceAssistantMode;
  readonly input: VoiceInputPhase;
  readonly output: VoiceOutputPhase;
  readonly transport: VoiceTransportPhase;
  readonly microphone: VoiceMicrophoneState;
  readonly conversationProvider: VoiceConversationProvider;
  readonly silenceTimeoutSeconds: VoiceSilenceTimeoutSeconds;
  /** Final recognized request for the current command window, if any. */
  readonly transcript: string;
  readonly partialTranscript: string;
  readonly lastAnnouncement: string | null;
  readonly lastError: string | null;
  /** Monotonic; a late callback from an older session must be ignored. */
  readonly sessionGeneration: number;
}

export interface VoiceCapturePort {
  /** Opens the local detection pipeline (wake mode); never uploads ambient audio. */
  openWake(): Promise<void>;
  /** Closes the local detection pipeline. */
  closeWake(): Promise<void>;
  /** Opens the upload gate for one command utterance. */
  beginUtterance(): Promise<void>;
  /** Closes the upload gate; no further audio may be sent for this utterance. */
  endUtterance(): Promise<void>;
  /** Bounded pre-roll retained locally to avoid losing the first command word. */
  preRoll(): Uint8Array | null;
  dispose(): Promise<void>;
}

export interface VoiceConversationPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendAudio(chunk: Uint8Array): void;
  /** Text-triggered speech, e.g. `speak("Mobile layout finished its turn.")`. */
  sendText(text: string): void;
  /** Provider must not finalize before this is called; local VAD owns the timer. */
  finalizeInput(): void;
  cancel(): void;
}

export interface VoicePlaybackPort {
  /** Stops local playback immediately (push-to-talk interrupt, "stop speaking"). */
  stop(): Promise<void>;
}

export interface VoiceAssistantPorts {
  readonly capture: VoiceCapturePort;
  readonly conversation: VoiceConversationPort;
  readonly playback: VoicePlaybackPort;
}

export interface VoiceTimerHandle {
  readonly id: number;
}

export interface VoiceAssistantOptions {
  readonly ports: VoiceAssistantPorts;
  readonly conversationProvider: VoiceConversationProvider;
  readonly silenceTimeoutSeconds: VoiceSilenceTimeoutSeconds;
  readonly onStateChange?: (state: VoiceAssistantState) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => VoiceTimerHandle;
  readonly clearTimer?: (handle: VoiceTimerHandle) => void;
  /** Initial maximum command window; product default, not a model limit. */
  readonly maxCaptureMs?: number;
}

export const DEFAULT_MAX_CAPTURE_MS = 120_000;
export const WAKE_PRE_ROLL_MS = 1_000;
