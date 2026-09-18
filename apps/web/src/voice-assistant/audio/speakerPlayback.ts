import { int16ToFloat32 } from "./pcm.ts";

const DEFAULT_SAMPLE_RATE = 24_000;
const UNAVAILABLE_MESSAGE = "Audio playback is not available in this browser.";
/**
 * Small lead-in so a chunk that arrives just after the cursor has passed starts
 * smoothly instead of butting against the live clock. Chunks arrive over the
 * network in bursts; without this the gaps and immediate restarts sound like
 * crackling.
 */
const SCHEDULE_LEAD_SECONDS = 0.04;

export interface SpeakerPlaybackOptions {
  /** PCM sample rate of the incoming chunks; defaults to Gemini Live's 24000. */
  readonly sampleRate?: number;
  /** Fires when the last scheduled source finishes or `stop()` cancels audio. */
  readonly onDrained?: () => void;
}

export interface SpeakerPlayback {
  /** Schedules a PCM16 little-endian chunk; lazily creates/resumes the context. */
  enqueue(pcm16: Uint8Array): void;
  resume(): Promise<void>;
  /** Stops all scheduled audio immediately, resets the queue, fires `onDrained`. */
  stop(): void;
  readonly speaking: boolean;
  dispose(): void;
}

export function createSpeakerPlayback(options: SpeakerPlaybackOptions = {}): SpeakerPlayback {
  return new WebAudioSpeakerPlayback(options);
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

class WebAudioSpeakerPlayback implements SpeakerPlayback {
  private readonly sampleRate: number;
  private readonly onDrained: (() => void) | undefined;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly endedHandlers = new Map<AudioBufferSourceNode, () => void>();

  private context: AudioContext | null = null;
  private cursorTime = 0;
  private disposed = false;

  constructor(options: SpeakerPlaybackOptions) {
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.onDrained = options.onDrained;
  }

  get speaking(): boolean {
    return this.sources.size > 0;
  }

  enqueue(pcm16: Uint8Array): void {
    if (this.disposed || pcm16.byteLength < 2) {
      return;
    }
    const context = this.ensureContext();
    const samples = int16ToFloat32(bytesToInt16(pcm16));
    const restarting = this.cursorTime <= context.currentTime;
    // Ramp only after silence; fading each network chunk creates audible modulation.
    if (restarting) {
      const ramp = Math.min(samples.length, Math.round(this.sampleRate * 0.005));
      for (let i = 0; i < ramp; i++) samples[i] = samples[i]! * (i / ramp);
    }

    const buffer = context.createBuffer(1, samples.length, this.sampleRate);
    buffer.getChannelData(0).set(samples);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    // Keep a small jitter buffer: if the cursor has fallen behind the clock
    // (network stall), resume with a lead instead of slamming audio in.
    const startAt = restarting ? context.currentTime + SCHEDULE_LEAD_SECONDS : this.cursorTime;
    this.cursorTime = startAt + buffer.duration;
    this.sources.add(source);
    const handleEnded = () => {
      this.endedHandlers.delete(source);
      this.sources.delete(source);
      source.disconnect();
      if (this.sources.size === 0) {
        this.cursorTime = 0;
        this.onDrained?.();
      }
    };
    this.endedHandlers.set(source, handleEnded);
    source.addEventListener("ended", handleEnded, { once: true });
    source.start(startAt);
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();
  }

  stop(): void {
    this.cancelSources();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelSources();
    const context = this.context;
    this.context = null;
    if (context !== null && context.state !== "closed") {
      void context.close();
    }
  }

  private cancelSources(): void {
    const pending = [...this.sources];
    this.sources.clear();
    for (const source of pending) {
      // Detach before stopping so cancellation does not look like a natural end.
      const handleEnded = this.endedHandlers.get(source);
      if (handleEnded !== undefined) {
        source.removeEventListener("ended", handleEnded);
        this.endedHandlers.delete(source);
      }
      try {
        source.stop();
      } catch {
        // Already stopped or never started; nothing to cancel.
      }
      source.disconnect();
    }
    this.cursorTime = 0;
  }

  private ensureContext(): AudioContext {
    if (this.context !== null) {
      return this.context;
    }
    const AudioContextCtor = resolveAudioContextConstructor();
    if (AudioContextCtor === null) {
      throw new Error(UNAVAILABLE_MESSAGE);
    }
    const context = new AudioContextCtor();
    this.context = context;
    if (context.state === "suspended") {
      context.resume().catch(() => undefined);
    }
    return context;
  }
}

/** Reads little-endian bytes into an `Int16Array` without alignment pitfalls. */
function bytesToInt16(bytes: Uint8Array): Int16Array {
  const length = Math.floor(bytes.byteLength / 2);
  const samples = new Int16Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof AudioContext !== "undefined") {
    return AudioContext;
  }
  const legacy = globalThis as { webkitAudioContext?: AudioContextConstructor };
  return legacy.webkitAudioContext ?? null;
}
