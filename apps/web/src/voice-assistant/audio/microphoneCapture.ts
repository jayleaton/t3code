import type { VoiceCapturePort } from "@t3tools/client-runtime/voice-assistant";

import { downsampleToRate, floatTo16BitPcm, pcm16Bytes } from "./pcm.ts";

const DEFAULT_TARGET_SAMPLE_RATE = 16_000;
const WORKLET_PROCESSOR_NAME = "t3-voice-capture";
const LEVEL_THROTTLE_MS = 100;
const UNAVAILABLE_MESSAGE = "Microphone capture is not available in this browser.";

/**
 * Registered from a Blob URL so the capture layer needs no bundler entry or
 * separate worklet file. The processor forwards a copy of the first input
 * channel; all conversion happens on the main thread.
 */
const WORKLET_SOURCE = `
class T3VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(320);
    this.length = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        for (let i = 0; i < channel.length; i++) {
          this.pending[this.length++] = channel[i];
          if (this.length === this.pending.length) {
            this.port.postMessage(this.pending);
            this.pending = new Float32Array(320);
            this.length = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("${WORKLET_PROCESSOR_NAME}", T3VoiceCaptureProcessor);
`;

export interface MicrophoneCaptureOptions {
  /** Output frame rate; defaults to 16000 for the Gemini Live input format. */
  readonly targetSampleRate?: number;
  /** Specific input device; empty/undefined uses the system default. */
  readonly deviceId?: string;
  /** Receives Int16 little-endian frames at the target rate while streaming. */
  readonly onFrame?: (pcm16: Uint8Array) => void;
  /** Receives 0..1 RMS levels, throttled to roughly 10Hz. */
  readonly onLevel?: (level: number) => void;
  readonly onError?: (error: Error) => void;
}

export interface MicrophoneCapture extends VoiceCapturePort {
  /** Idempotent; safe to call repeatedly. */
  start(): Promise<void>;
  /** Resumes a suspended AudioContext; call from a user gesture (hotkey press). */
  resume(): Promise<void>;
  /** True while the utterance upload gate is open. */
  getStreaming(): boolean;
  /** Idempotent and safe before `start()`. */
  dispose(): Promise<void>;
}

export function createMicrophoneCapture(options: MicrophoneCaptureOptions = {}): MicrophoneCapture {
  return new BrowserMicrophoneCapture(options);
}

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

class BrowserMicrophoneCapture implements MicrophoneCapture {
  private readonly targetSampleRate: number;
  private readonly deviceId: string | undefined;
  private readonly onFrame: ((pcm16: Uint8Array) => void) | undefined;
  private readonly onLevel: ((level: number) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;
  private workletMessageHandler: ((event: MessageEvent<unknown>) => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private streaming = false;
  private lastLevelAt = 0;
  private disposed = false;
  private generation = 0;
  private stopping: Promise<void> = Promise.resolve();

  constructor(options: MicrophoneCaptureOptions) {
    this.targetSampleRate = options.targetSampleRate ?? DEFAULT_TARGET_SAMPLE_RATE;
    this.deviceId = options.deviceId && options.deviceId.length > 0 ? options.deviceId : undefined;
    this.onFrame = options.onFrame;
    this.onLevel = options.onLevel;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.startPromise !== null) {
      return this.startPromise;
    }
    if (this.disposed) {
      throw new Error("Microphone capture has already been disposed.");
    }
    const attempt = this.stopping.then(() => this.startInternal());
    this.startPromise = attempt;
    attempt.catch(() => {
      if (this.startPromise === attempt) {
        this.startPromise = null;
      }
    });
    return attempt;
  }

  getStreaming(): boolean {
    return this.streaming;
  }

  /** Resumes the AudioContext; browsers suspend it until a user gesture. */
  async resume(): Promise<void> {
    const context = this.context;
    if (context !== null && context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // A later press will retry; do not surface a transient resume failure.
      }
    }
  }

  async openWake(): Promise<void> {
    return Promise.resolve();
  }

  async closeWake(): Promise<void> {
    return Promise.resolve();
  }

  async beginUtterance(): Promise<void> {
    const generation = ++this.generation;
    await this.start();
    if (generation !== this.generation || this.disposed) return;
    await this.resume();
    if (generation !== this.generation || this.disposed) return;
    this.streaming = true;
  }

  async endUtterance(): Promise<void> {
    this.generation += 1;
    this.streaming = false;
    const pending = this.startPromise;
    this.startPromise = null;
    this.stopping = this.stopping.then(async () => {
      await pending?.catch(() => undefined);
      await this.releaseResources();
      this.onLevel?.(0);
    });
    return this.stopping;
  }

  preRoll(): Uint8Array | null {
    return null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    this.streaming = false;
    await this.stopping;
    const pending = this.startPromise;
    if (pending !== null) {
      try {
        await pending;
      } catch {
        // A failed start already released its own resources.
      }
    }
    await this.releaseResources();
  }

  private async startInternal(): Promise<void> {
    try {
      const mediaDevices: MediaDevices | undefined = navigator.mediaDevices;
      const AudioContextCtor = resolveAudioContextConstructor();
      if (
        mediaDevices === undefined ||
        AudioContextCtor === null ||
        typeof AudioWorkletNode === "undefined"
      ) {
        throw new Error(UNAVAILABLE_MESSAGE);
      }

      const context = new AudioContextCtor({ sampleRate: this.targetSampleRate });
      this.context = context;
      const worklet = (context as { audioWorklet?: AudioWorklet }).audioWorklet;
      if (worklet === undefined || typeof worklet.addModule !== "function") {
        throw new Error(UNAVAILABLE_MESSAGE);
      }

      // Echo cancellation is essential: the assistant's own speech plays
      // through the speakers while the mic is live during barge-in, and without
      // it the model can hear itself as a feedback loop that sounds like noise.
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(this.deviceId === undefined ? {} : { deviceId: { exact: this.deviceId } }),
      };
      const stream = await mediaDevices.getUserMedia({ audio: audioConstraints });
      this.stream = stream;

      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
      );
      this.workletUrl = workletUrl;
      await worklet.addModule(workletUrl);
      this.revokeWorkletUrl();

      if (context.state === "suspended") {
        await context.resume();
      }

      const sourceNode = context.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME);
      const handleMessage = (event: MessageEvent<unknown>) => {
        this.handleWorkletMessage(event.data);
      };
      this.workletMessageHandler = handleMessage;
      workletNode.port.addEventListener("message", handleMessage);
      // A MessagePort only dispatches on addEventListener after start() is
      // called; without it the worklet's audio messages queue forever.
      workletNode.port.start();
      sourceNode.connect(workletNode);
      // The processor emits silence; the destination edge just keeps it alive.
      workletNode.connect(context.destination);
      this.sourceNode = sourceNode;
      this.workletNode = workletNode;
    } catch (error) {
      await this.releaseResources();
      const failure = toError(error, UNAVAILABLE_MESSAGE);
      this.onError?.(failure);
      throw failure;
    }
  }

  private handleWorkletMessage(data: unknown): void {
    if (!(data instanceof Float32Array)) {
      return;
    }
    try {
      this.reportLevel(data);
      if (!this.streaming) {
        return;
      }
      const inputRate = this.context?.sampleRate ?? this.targetSampleRate;
      const downsampled = downsampleToRate(data, inputRate, this.targetSampleRate);
      this.onFrame?.(pcm16Bytes(floatTo16BitPcm(downsampled)));
    } catch (error) {
      this.onError?.(toError(error, "Failed to process microphone audio."));
    }
  }

  private reportLevel(samples: Float32Array): void {
    const onLevel = this.onLevel;
    if (onLevel === undefined) {
      return;
    }
    const now = performance.now();
    if (now - this.lastLevelAt < LEVEL_THROTTLE_MS) {
      return;
    }
    this.lastLevelAt = now;
    onLevel(rootMeanSquare(samples));
  }

  private async releaseResources(): Promise<void> {
    this.streaming = false;

    const workletNode = this.workletNode;
    const workletMessageHandler = this.workletMessageHandler;
    this.workletNode = null;
    this.workletMessageHandler = null;
    if (workletNode !== null) {
      if (workletMessageHandler !== null) {
        workletNode.port.removeEventListener("message", workletMessageHandler);
      }
      workletNode.disconnect();
    }

    const sourceNode = this.sourceNode;
    this.sourceNode = null;
    sourceNode?.disconnect();

    const stream = this.stream;
    this.stream = null;
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    this.revokeWorkletUrl();

    const context = this.context;
    this.context = null;
    if (context !== null && context.state !== "closed") {
      await context.close();
    }
  }

  private revokeWorkletUrl(): void {
    const workletUrl = this.workletUrl;
    if (workletUrl === null) {
      return;
    }
    this.workletUrl = null;
    URL.revokeObjectURL(workletUrl);
  }
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof AudioContext !== "undefined") {
    return AudioContext;
  }
  const legacy = globalThis as { webkitAudioContext?: AudioContextConstructor };
  return legacy.webkitAudioContext ?? null;
}

function toError(value: unknown, fallbackMessage: string): Error {
  return value instanceof Error ? value : new Error(fallbackMessage);
}
