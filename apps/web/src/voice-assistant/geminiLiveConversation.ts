import type { VoiceConversationPort } from "@t3tools/client-runtime/voice-assistant";

const GEMINI_LIVE_SOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const AUDIO_MIME_TYPE = "audio/pcm;rate=16000";
const BASE64_CHUNK_SIZE = 0x8000;

export interface GeminiLiveSocket {
  send(data: string): void;
  close(): void;
  /** 0=CONNECTING, 1=OPEN; used to avoid sending before the handshake. */
  readonly readyState?: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const SOCKET_OPEN = 1;

export interface GeminiLiveTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface GeminiLiveCallbacks {
  readonly onOpen?: () => void;
  readonly onClose?: (event: { readonly code: number; readonly reason: string }) => void;
  readonly onError?: (error: Error) => void;
  readonly onAudio?: (chunk: Uint8Array) => void;
  readonly onInputTranscript?: (text: string) => void;
  readonly onOutputTranscript?: (text: string) => void;
  readonly onSpeechStart?: () => void;
  readonly onSpeechEnd?: () => void;
  readonly onTurnComplete?: () => void;
  readonly onInterrupted?: () => void;
  readonly onToolCall?: (
    call: {
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
    },
    signal: AbortSignal,
  ) => void;
}

export interface GeminiLiveConversationOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly systemInstruction?: string;
  readonly tools?: ReadonlyArray<GeminiLiveTool>;
  readonly callbacks?: GeminiLiveCallbacks;
  readonly createSocket: (url: string) => GeminiLiveSocket;
}

/**
 * Browser/Electron adapter for the Gemini Live bidirectional WebSocket. The
 * socket is injected so tests (and the desktop shell) can supply their own
 * transport; the API key is only ever used to build the connect URL.
 */
export class GeminiLiveConversation implements VoiceConversationPort {
  private socket: GeminiLiveSocket | null = null;
  private ready = false;
  private activity = false;
  private pendingAudio: Uint8Array[] = [];
  private pendingAudioBytes = 0;
  private connection: Promise<void> | null = null;
  private rejectConnection: ((cause: Error) => void) | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private turn = new AbortController();
  private toolNames = new Map<string, string>();
  private history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  private inputText = "";
  private outputText = "";

  constructor(private readonly options: GeminiLiveConversationOptions) {}

  get isConnected(): boolean {
    return this.ready;
  }
  get activityOpen(): boolean {
    return this.activity;
  }

  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.connection !== null) return this.connection;
    const generation = ++this.generation;
    this.turn = new AbortController();
    const socket = this.options.createSocket(buildSocketUrl(this.options.apiKey));
    this.socket = socket;
    const current = () => this.socket === socket && this.generation === generation;
    this.connection = new Promise<void>((resolve, reject) => {
      this.rejectConnection = reject;
      this.setupTimer = setTimeout(() => {
        if (!current()) return;
        const error = new Error("Gemini did not finish connecting. Try push-to-talk again.");
        this.closeSocket(error);
        this.options.callbacks?.onError?.(error);
      }, 15_000);
      socket.onopen = () => {
        if (current())
          socket.send(
            buildSetupMessage(
              this.options.model,
              this.options.systemInstruction,
              this.options.tools ?? [],
            ),
          );
      };
      // Serialize Blob decoding so audio, tools, and completion retain wire order.
      let inbound = Promise.resolve();
      socket.onmessage = (event) => {
        inbound = inbound
          .then(async () => {
            const message: unknown = JSON.parse(await decodeSocketData(event.data));
            if (!current()) return;
            if (!isRecord(message)) throw new Error("Gemini sent a non-object message.");
            if (isRecord(message["setupComplete"])) {
              if (this.setupTimer !== null) clearTimeout(this.setupTimer);
              this.setupTimer = null;
              this.ready = true;
              this.rejectConnection = null;
              if (this.history.length > 0)
                this.send({ clientContent: { turns: this.history, turnComplete: false } });
              const pending = this.pendingAudio;
              this.pendingAudio = [];
              this.pendingAudioBytes = 0;
              for (const chunk of pending) this.sendAudio(chunk);
              resolve();
              this.options.callbacks?.onOpen?.();
            }
            if (isRecord(message["error"]))
              throw new Error(String(message["error"]["message"] ?? "Gemini session failed."));
            const cancelled = message["toolCallCancellation"];
            if (isRecord(cancelled)) {
              this.turn.abort();
              this.turn = new AbortController();
            }
            const content = message["serverContent"];
            if (isRecord(content)) this.handleContent(content);
            const tool = message["toolCall"];
            if (
              isRecord(tool) &&
              Array.isArray(tool["functionCalls"]) &&
              !this.turn.signal.aborted
            ) {
              for (const call of tool["functionCalls"]) {
                if (
                  !isRecord(call) ||
                  typeof call["id"] !== "string" ||
                  typeof call["name"] !== "string"
                )
                  continue;
                if (this.toolNames.has(call["id"])) continue;
                this.toolNames.set(call["id"], call["name"]);
                this.options.callbacks?.onToolCall?.(
                  { id: call["id"], name: call["name"], args: call["args"] },
                  this.turn.signal,
                );
              }
            }
          })
          .catch((cause: unknown) => {
            if (!current()) return;
            const error = toError(cause);
            this.closeSocket(error);
            this.options.callbacks?.onError?.(error);
          });
      };
      socket.onerror = () => {
        if (!current()) return;
        const error = new Error("Gemini Live connection failed. Try push-to-talk again.");
        this.closeSocket(error);
        this.options.callbacks?.onError?.(error);
      };
      socket.onclose = (event) => {
        if (!current()) return;
        this.closeSocket(new Error(event.reason || "Gemini connection closed."));
        this.options.callbacks?.onClose?.(event);
      };
    });
    return this.connection;
  }

  async disconnect(): Promise<void> {
    this.closeSocket();
  }

  sendAudio(chunk: Uint8Array): void {
    if (chunk.length === 0 || this.socket === null) return;
    if (!this.ready) {
      if (this.pendingAudioBytes + chunk.byteLength > 1_000_000) {
        const error = new Error("Voice connection is taking too long. Please try again.");
        this.closeSocket(error);
        this.options.callbacks?.onError?.(error);
        return;
      }
      this.pendingAudio.push(chunk.slice());
      this.pendingAudioBytes += chunk.byteLength;
      return;
    }
    if (!this.activity) {
      this.activity = true;
      this.send({ realtimeInput: { activityStart: {} } });
    }
    this.send({
      realtimeInput: { audio: { mimeType: AUDIO_MIME_TYPE, data: encodeBase64(chunk) } },
    });
  }

  sendText(text: string): void {
    this.send({
      clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
    });
  }

  sendToolResponse(callId: string, result: unknown): void {
    const name = this.toolNames.get(callId);
    if (name === undefined || this.turn.signal.aborted) return;
    this.send({
      toolResponse: { functionResponses: [{ id: callId, name, response: { result } }] },
    });
  }

  finalizeInput(): void {
    if (!this.activity) {
      this.options.callbacks?.onTurnComplete?.();
      return;
    }
    this.activity = false;
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  // Closing the cancelled session is the definitive boundary for late audio and
  // tool calls. Completed conversation text is restored on the next connection.
  cancel(): void {
    this.closeSocket();
  }

  private send(value: unknown): void {
    if (
      this.ready &&
      this.socket !== null &&
      (this.socket.readyState === undefined || this.socket.readyState === SOCKET_OPEN)
    ) {
      this.socket.send(JSON.stringify(value));
    }
  }

  private closeSocket(cause = new Error("Voice session cancelled.")): void {
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    this.ready = false;
    this.activity = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.turn.abort();
    this.toolNames.clear();
    this.inputText = "";
    this.outputText = "";
    if (this.setupTimer !== null) clearTimeout(this.setupTimer);
    this.setupTimer = null;
    this.rejectConnection?.(cause);
    this.rejectConnection = null;
    this.connection = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  }

  private handleContent(content: Record<string, unknown>): void {
    const callbacks = this.options.callbacks;
    if (content["interrupted"] === true) {
      callbacks?.onInterrupted?.();
      this.outputText = "";
    }
    const input = content["inputTranscription"];
    if (isRecord(input) && typeof input["text"] === "string") {
      this.inputText += input["text"];
      callbacks?.onInputTranscript?.(this.inputText);
    }
    const output = content["outputTranscription"];
    if (isRecord(output) && typeof output["text"] === "string") {
      this.outputText += output["text"];
      callbacks?.onOutputTranscript?.(this.outputText);
    }
    const modelTurn = content["modelTurn"];
    if (isRecord(modelTurn) && Array.isArray(modelTurn["parts"])) {
      for (const part of modelTurn["parts"]) {
        if (!isRecord(part) || !isRecord(part["inlineData"])) continue;
        const data = part["inlineData"]["data"];
        if (typeof data === "string") callbacks?.onAudio?.(decodeBase64(data));
      }
    }
    if (content["turnComplete"] === true) {
      if (this.inputText) this.history.push({ role: "user", parts: [{ text: this.inputText }] });
      if (this.outputText) this.history.push({ role: "model", parts: [{ text: this.outputText }] });
      this.history = this.history.slice(-12);
      this.inputText = "";
      this.outputText = "";
      callbacks?.onTurnComplete?.();
    }
  }
}

/** JSON string of the `toolResponse` frame that answers one function call. */
export function respondToToolCall(callId: string, result: unknown): string {
  return JSON.stringify({
    toolResponse: { functionResponses: [{ id: callId, response: { result } }] },
  });
}

/**
 * Normalizes the three frame shapes a browser WebSocket can hand us. Kept
 * separate so the string/ArrayBuffer paths stay unit-testable without a socket.
 */
export async function decodeSocketData(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  throw new Error("Gemini Live received an unsupported frame.");
}

function buildSocketUrl(apiKey: string): string {
  return `${GEMINI_LIVE_SOCKET_URL}?key=${encodeURIComponent(apiKey)}`;
}

function buildSetupMessage(
  model: string,
  systemInstruction: string | undefined,
  tools: ReadonlyArray<GeminiLiveTool>,
): string {
  // Shape verified against the live v1beta WebSocket proto: the server rejects
  // a top-level `responseModalities` ("Unknown name ... at 'setup'"), so it
  // belongs under `generationConfig`. Manual VAD is opted into by disabling
  // automatic activity detection, and `gemini-3.8-live` takes no thinking
  // config (`thinking_level` is unsupported for that model).
  return JSON.stringify({
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools }] } : {}),
    },
  });
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this runtime.");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is unavailable in this runtime.");
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
