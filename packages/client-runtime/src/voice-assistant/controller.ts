// The controller is deliberately framework-agnostic plain TypeScript with an
// injected effects port; timers default to platform timers and are always
// overridable for deterministic tests.
// @effect-diagnostics globalTimers:off
import type { VoiceAssistantMode, VoiceSilenceTimeoutSeconds } from "@t3tools/contracts";

import {
  DEFAULT_MAX_CAPTURE_MS,
  type VoiceAssistantOptions,
  type VoiceAssistantState,
  type VoiceMicrophoneState,
  type VoiceTimerHandle,
} from "./ports.ts";

const defaultSetTimer = (callback: () => void, ms: number): VoiceTimerHandle => ({
  id: setTimeout(callback, ms) as unknown as number,
});

const defaultClearTimer = (handle: VoiceTimerHandle): void => {
  clearTimeout(handle.id as unknown as ReturnType<typeof setTimeout>);
};

interface PendingAnnouncement {
  readonly text: string;
}

/**
 * Pure transition logic for the voice assistant, with an injected effects port.
 *
 * Invariants this class owns:
 * - Input, output, and transport move independently; announcements never
 *   require an open microphone.
 * - Push-to-talk lasts until release (or the bounded maximum). Only wake-mode
 *   command windows use a speech-driven silence deadline.
 * - Every utterance is stamped with a generation. A late transcript, timer, or
 *   provider callback from an older generation is ignored, so disabling or
 *   cancelling can never execute a stale command.
 * - `off` releases all capture, playback, and transport resources.
 */
export class VoiceAssistantController {
  private state: VoiceAssistantState;
  private generation = 0;
  private silenceTimer: VoiceTimerHandle | null = null;
  private maxTimer: VoiceTimerHandle | null = null;
  private acceptedSpeech = false;
  private readonly pendingAnnouncements: PendingAnnouncement[] = [];
  private disposed = false;
  private captureStart: Promise<void> = Promise.resolve();

  private readonly ports: VoiceAssistantOptions["ports"];
  private readonly onStateChange: ((state: VoiceAssistantState) => void) | undefined;
  private readonly setTimer: (callback: () => void, ms: number) => VoiceTimerHandle;
  private readonly clearTimer: (handle: VoiceTimerHandle) => void;
  private readonly maxCaptureMs: number;

  constructor(options: VoiceAssistantOptions) {
    this.ports = options.ports;
    this.onStateChange = options.onStateChange;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.maxCaptureMs = options.maxCaptureMs ?? DEFAULT_MAX_CAPTURE_MS;
    this.state = {
      mode: "off",
      input: "off",
      output: "idle",
      transport: "disconnected",
      microphone: "released",
      conversationProvider: options.conversationProvider,
      silenceTimeoutSeconds: options.silenceTimeoutSeconds,
      transcript: "",
      partialTranscript: "",
      lastAnnouncement: null,
      lastError: null,
      sessionGeneration: 0,
    };
  }

  getState(): VoiceAssistantState {
    return this.state;
  }

  private update(patch: Partial<VoiceAssistantState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.(this.state);
  }

  private clearTimers(): void {
    if (this.silenceTimer !== null) {
      this.clearTimer(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.maxTimer !== null) {
      this.clearTimer(this.maxTimer);
      this.maxTimer = null;
    }
  }

  private microphoneForMode(mode: VoiceAssistantMode): VoiceMicrophoneState {
    return mode === "wake-word" ? "wake-listening" : "released";
  }

  private restartSilenceTimer(): void {
    if (this.state.mode === "push-to-talk") return;
    if (this.silenceTimer !== null) {
      this.clearTimer(this.silenceTimer);
      this.silenceTimer = null;
    }
    const generation = this.generation;
    this.silenceTimer = this.setTimer(
      () => this.handleSilenceTimeout(generation),
      this.state.silenceTimeoutSeconds * 1000,
    );
  }

  private startCapture(includePreRoll: boolean): void {
    this.generation += 1;
    const generation = this.generation;
    this.acceptedSpeech = false;
    this.update({
      input: "capturing",
      microphone: "streaming",
      partialTranscript: "",
      transcript: "",
      lastError: null,
      sessionGeneration: generation,
    });
    // Acquire capture immediately; the transport buffers PCM until setup completes,
    // so interrupting speech does not lose the first words during reconnection.
    this.captureStart = Promise.all([
      this.ports.conversation.connect(),
      this.ports.capture.beginUtterance(),
    ])
      .then(() => {
        if (generation !== this.generation || this.state.input !== "capturing") return;
        if (includePreRoll) {
          const preRoll = this.ports.capture.preRoll();
          if (preRoll !== null) this.ports.conversation.sendAudio(preRoll);
        }
        this.restartSilenceTimer();
        this.maxTimer = this.setTimer(() => this.handleMaxCapture(generation), this.maxCaptureMs);
      })
      .catch((cause: unknown) => {
        if (generation !== this.generation) return;
        this.cancel();
        this.update({
          lastError: cause instanceof Error ? cause.message : "Could not start voice capture.",
        });
      });
  }

  private async finalizeUtterance(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    if (this.state.input !== "capturing") return;
    this.clearTimers();
    this.update({ input: "finalizing" });
    await this.ports.capture.endUtterance();
    await this.captureStart;
    if (generation !== this.generation) return;
    this.update({ output: "preparing", microphone: this.microphoneForMode(this.state.mode) });
    this.ports.conversation.finalizeInput();
  }

  /** Accepted human speech; the only thing that extends a command window. */
  handleAcceptedSpeech(): void {
    if (this.state.input !== "capturing") return;
    this.acceptedSpeech = true;
    this.restartSilenceTimer();
  }

  handlePartialTranscript(text: string): void {
    if (this.state.input !== "capturing") return;
    this.update({ partialTranscript: text });
  }

  handleFinalTranscript(text: string): void {
    if (this.state.input !== "capturing" && this.state.input !== "finalizing") return;
    this.update({ transcript: text });
    if (text.trim().length > 0) {
      this.acceptedSpeech = true;
      this.restartSilenceTimer();
    }
  }

  private handleSilenceTimeout(generation: number): void {
    if (generation !== this.generation || this.state.input !== "capturing") return;
    this.silenceTimer = null;
    if (!this.acceptedSpeech && this.state.transcript.trim().length === 0) {
      // No-speech activation closes silently: no model turn, no upload.
      this.cancel("no-speech");
      return;
    }
    void this.finalizeUtterance(generation);
  }

  private handleMaxCapture(generation: number): void {
    if (generation !== this.generation || this.state.input !== "capturing") return;
    this.maxTimer = null;
    void this.finalizeUtterance(generation);
  }

  async setMode(mode: VoiceAssistantMode): Promise<void> {
    if (this.disposed || mode === this.state.mode) return;
    if (mode === "off") {
      await this.disable();
      return;
    }
    // Switching modes re-arms capture from a clean slate, preserving only the
    // provider/transport-independent settings.
    await this.releaseCapture();
    this.update({
      mode,
      input: "standby",
      microphone: this.microphoneForMode(mode),
      output: "idle",
    });
    if (mode === "wake-word") {
      await this.ports.capture.openWake();
    }
  }

  async pressPushToTalk(): Promise<void> {
    if (this.disposed || this.state.mode === "off") return;
    if (this.state.input === "capturing") return;
    // Stop actual scheduled audio even if generation has already completed.
    void this.ports.playback.stop();
    if (this.state.output !== "idle" || this.state.input === "finalizing") {
      this.ports.conversation.cancel();
    }
    this.update({ output: "idle" });
    this.startCapture(false);
  }

  async releasePushToTalk(): Promise<void> {
    if (this.state.mode !== "push-to-talk" || this.state.input !== "capturing") return;
    await this.finalizeUtterance(this.generation);
  }

  /** Wake detector fired; retains bounded local pre-roll to keep the first word. */
  async handleWakeDetected(): Promise<void> {
    if (this.disposed || this.state.mode !== "wake-word" || this.state.input !== "standby") return;
    this.startCapture(true);
  }

  /** The host calls this when the provider turn for the command window finishes. */
  completeCommandWindow(): void {
    if (this.state.input !== "finalizing") return;
    this.update({
      input: "standby",
      microphone: this.microphoneForMode(this.state.mode),
      partialTranscript: "",
    });
  }

  /** Speak an agent event. Works while the microphone is released and while off. */
  announce(text: string): void {
    if (this.disposed || this.state.mode === "off") return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.update({ lastAnnouncement: trimmed });
    // Never speak over capture; queue until the channel is free.
    if (this.state.input !== "standby" || this.state.output !== "idle") {
      if (this.pendingAnnouncements.length >= 20) this.pendingAnnouncements.shift();
      this.pendingAnnouncements.push({ text: trimmed });
      return;
    }
    this.speak(trimmed);
  }

  private speak(text: string): void {
    this.update({ output: "preparing" });
    const generation = this.generation;
    void this.ports.conversation
      .connect()
      .then(() => {
        if (generation === this.generation && !this.disposed)
          this.ports.conversation.sendText(text);
      })
      .catch((cause: unknown) => {
        if (generation !== this.generation) return;
        this.update({
          output: "idle",
          lastError: cause instanceof Error ? cause.message : "Voice connection failed.",
        });
      });
  }

  private flushAnnouncements(): void {
    const next = this.pendingAnnouncements.shift();
    if (next !== undefined) {
      this.speak(next.text);
    }
  }

  /** The live provider tells us speech playback began. */
  handleAssistantSpeechStart(): void {
    if (this.state.output === "idle") return;
    this.update({ output: "speaking" });
  }

  /** The live provider tells us its turn finished. */
  handleAssistantSpeechEnd(): void {
    this.update({ output: "idle" });
    if (this.state.input === "finalizing") {
      this.completeCommandWindow();
    }
    // Queued announcements waited for the command window; speak them now.
    if (this.pendingAnnouncements.length > 0) {
      this.flushAnnouncements();
    }
  }

  /** "Stop speaking": stop playback without touching agent work. */
  async stopSpeaking(): Promise<void> {
    await this.ports.playback.stop();
    this.ports.conversation.cancel();
    this.update({ output: "idle" });
  }

  /**
   * Escape/disable: invalidate the current session and drop queued proposals.
   * A dispatched operation is reconciled later, never claimed undone.
   */
  cancel(reason?: string): void {
    if (this.disposed) return;
    this.generation += 1;
    this.clearTimers();
    this.acceptedSpeech = false;
    this.pendingAnnouncements.length = 0;
    void this.ports.capture.endUtterance();
    void this.ports.playback.stop();
    this.ports.conversation.cancel();
    this.update({
      input: this.state.mode === "off" ? "off" : "standby",
      microphone: this.state.mode === "off" ? "released" : this.microphoneForMode(this.state.mode),
      output: "idle",
      transport: "disconnected",
      partialTranscript: "",
      transcript: "",
      sessionGeneration: this.generation,
      ...(reason === undefined ? {} : { lastError: null }),
    });
  }

  private async releaseCapture(): Promise<void> {
    this.generation += 1;
    this.clearTimers();
    this.acceptedSpeech = false;
    await this.ports.capture.endUtterance().catch(() => undefined);
    await this.ports.capture.closeWake().catch(() => undefined);
  }

  async disable(): Promise<void> {
    await this.releaseCapture();
    this.pendingAnnouncements.length = 0;
    void this.ports.capture.endUtterance();
    void this.ports.playback.stop();
    this.ports.conversation.cancel();
    this.update({
      mode: "off",
      input: "off",
      output: "idle",
      transport: "disconnected",
      microphone: "released",
      partialTranscript: "",
      transcript: "",
      sessionGeneration: this.generation,
    });
  }

  /** Provider transport lifecycle; input/output do not depend on it being open. */
  setTransport(transport: VoiceAssistantState["transport"]): void {
    if (this.disposed) return;
    this.update({ transport });
  }

  setSilenceTimeoutSeconds(seconds: VoiceSilenceTimeoutSeconds): void {
    this.update({ silenceTimeoutSeconds: seconds });
    if (this.state.input === "capturing") {
      this.restartSilenceTimer();
    }
  }

  /** Pending proposals are invalidated on cancel; this reports how many were dropped. */
  getPendingProposalCount(): number {
    return this.pendingAnnouncements.length;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.pendingAnnouncements.length = 0;
    void this.ports.capture.endUtterance();
    void this.ports.playback.stop();
    this.ports.conversation.cancel();
    await this.ports.capture.dispose().catch(() => undefined);
    await this.ports.conversation.disconnect().catch(() => undefined);
  }
}
