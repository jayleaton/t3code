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
const MAX_PENDING_OUTBOUND = 512;

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
  readonly onToolCall?: (call: {
    readonly id: string;
    readonly name: string;
    readonly args: unknown;
  }) => void;
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
  private readonly apiKey: string;
  private readonly model: string;
  private readonly systemInstruction: string | undefined;
  private readonly tools: ReadonlyArray<GeminiLiveTool>;
  private readonly callbacks: GeminiLiveCallbacks;
  private readonly createSocket: (url: string) => GeminiLiveSocket;

  private socket: GeminiLiveSocket | null = null;
  private connected = false;
  private activity = false;
  private pendingOutbound: string[] = [];
  private muted = false;

  constructor(options: GeminiLiveConversationOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.systemInstruction = options.systemInstruction;
    this.tools = options.tools ?? [];
    this.callbacks = options.callbacks ?? {};
    this.createSocket = options.createSocket;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get activityOpen(): boolean {
    return this.activity;
  }

  async connect(): Promise<void> {
    if (this.socket !== null) {
      return;
    }
    const socket = this.createSocket(buildSocketUrl(this.apiKey));
    this.socket = socket;
    this.connected = false;
    this.activity = false;
    this.muted = false;
    this.pendingOutbound = [];
    socket.onopen = () => {
      this.notifyOpen();
      this.flushPendingOutbound();
    };
    socket.onmessage = (event) => {
      void this.handleMessage(event.data);
    };
    socket.onclose = (event) => {
      this.socket = null;
      this.connected = false;
      this.activity = false;
      this.pendingOutbound = [];
      this.callbacks.onClose?.(event);
    };
    socket.onerror = () => {
      this.callbacks.onError?.(new Error("Gemini Live socket error."));
    };
    // The socket is normally CONNECTING here; sending now throws in the browser,
    // so the setup frame is queued and flushed on open.
    this.sendOrQueue(buildSetupMessage(this.model, this.systemInstruction, this.tools));
  }

  async disconnect(): Promise<void> {
    this.closeSocket();
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.socket === null) {
      return;
    }
    // A new utterance resumes model output after an interruption.
    this.muted = false;
    if (!this.activity) {
      this.activity = true;
      this.sendOrQueue(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    }
    this.sendOrQueue(
      JSON.stringify({
        realtimeInput: { audio: { mimeType: AUDIO_MIME_TYPE, data: encodeBase64(chunk) } },
      }),
    );
  }

  sendText(text: string): void {
    this.sendOrQueue(
      JSON.stringify({
        clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true },
      }),
    );
  }

  /** Answers one function call; the model continues from the result. */
  sendToolResponse(callId: string, result: unknown): void {
    this.sendOrQueue(respondToToolCall(callId, result));
  }

  /**
   * Local VAD owns utterance boundaries; repeat calls are ignored so a
   * straggling finalize cannot close an utterance twice.
   */
  finalizeInput(): void {
    if (!this.activity) {
      return;
    }
    this.activity = false;
    this.sendOrQueue(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
  }

  /**
   * Cancels the current activity without closing the session: dropping the
   * socket here would silently end the conversation and lose all context.
   * `disconnect()` is the only teardown path.
   */
  cancel(): void {
    if (this.activity) {
      this.activity = false;
      this.sendOrQueue(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    }
    // Stop surfacing model audio/transcripts for the interrupted turn until the
    // next utterance or turn completion.
    this.muted = true;
  }

  private notifyOpen(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.callbacks.onOpen?.();
  }

  /**
   * Sends immediately when the socket is open, otherwise queues. The browser
   * throws "Still in CONNECTING state" if `send` is called before the
   * handshake completes, and that must never abort a session.
   */
  private sendOrQueue(message: string): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    if (socket.readyState === undefined || socket.readyState === SOCKET_OPEN) {
      try {
        socket.send(message);
        return;
      } catch (error) {
        this.callbacks.onError?.(toError(error));
        return;
      }
    }
    // Bound the queue so a socket that never opens cannot grow memory without
    // limit; dropping the oldest audio is preferable to unbounded buffering.
    if (this.pendingOutbound.length >= MAX_PENDING_OUTBOUND) {
      this.pendingOutbound.shift();
    }
    this.pendingOutbound.push(message);
  }

  private flushPendingOutbound(): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    const queued = this.pendingOutbound;
    this.pendingOutbound = [];
    for (const message of queued) {
      try {
        socket.send(message);
      } catch (error) {
        this.callbacks.onError?.(toError(error));
        return;
      }
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    this.socket = null;
    this.connected = false;
    this.activity = false;
    this.muted = false;
    this.pendingOutbound = [];
    socket.close();
  }

  private async handleMessage(data: unknown): Promise<void> {
    let text: string;
    try {
      text = await decodeSocketData(data);
    } catch (error) {
      this.callbacks.onError?.(toError(error));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.callbacks.onError?.(new Error("Gemini Live sent malformed JSON."));
      return;
    }
    if (!isRecord(message)) {
      this.callbacks.onError?.(new Error("Gemini Live sent a non-object message."));
      return;
    }

    if (isRecord(message["setupComplete"])) {
      this.notifyOpen();
    }
    const serverContent = message["serverContent"];
    if (isRecord(serverContent)) {
      this.handleServerContent(serverContent);
    }
    const toolCall = message["toolCall"];
    if (isRecord(toolCall)) {
      this.handleToolCall(toolCall);
    }
  }

  private handleServerContent(content: Record<string, unknown>): void {
    if (this.muted) {
      // The interrupted turn may still stream a little audio; drop it, and
      // unmute once the server confirms the turn is over.
      if (content["turnComplete"] === true) {
        this.muted = false;
        this.callbacks.onTurnComplete?.();
      }
      return;
    }
    const inputTranscription = content["inputTranscription"];
    if (isRecord(inputTranscription) && typeof inputTranscription["text"] === "string") {
      this.callbacks.onInputTranscript?.(inputTranscription["text"]);
    }
    const outputTranscription = content["outputTranscription"];
    if (isRecord(outputTranscription) && typeof outputTranscription["text"] === "string") {
      this.callbacks.onOutputTranscript?.(outputTranscription["text"]);
    }

    const modelTurn = content["modelTurn"];
    if (isRecord(modelTurn) && Array.isArray(modelTurn["parts"])) {
      for (const part of modelTurn["parts"]) {
        if (!isRecord(part)) {
          continue;
        }
        const inlineData = part["inlineData"];
        if (isRecord(inlineData) && typeof inlineData["data"] === "string") {
          this.callbacks.onAudio?.(decodeBase64(inlineData["data"]));
        }
      }
    }

    if (content["turnComplete"] === true) {
      this.callbacks.onTurnComplete?.();
    }
    if (content["interrupted"] === true) {
      this.callbacks.onInterrupted?.();
    }
  }

  private handleToolCall(toolCall: Record<string, unknown>): void {
    const functionCalls = toolCall["functionCalls"];
    if (!Array.isArray(functionCalls)) {
      return;
    }
    for (const call of functionCalls) {
      if (!isRecord(call)) {
        continue;
      }
      const id = call["id"];
      const name = call["name"];
      if (typeof id !== "string" || typeof name !== "string") {
        continue;
      }
      this.callbacks.onToolCall?.({ id, name, args: call["args"] });
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
