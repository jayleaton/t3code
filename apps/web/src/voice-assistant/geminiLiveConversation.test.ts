import { describe, expect, it, vi } from "vite-plus/test";
import {
  GeminiLiveConversation,
  decodeSocketData,
  type GeminiLiveCallbacks,
  type GeminiLiveSocket,
} from "./geminiLiveConversation";

class Socket implements GeminiLiveSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: GeminiLiveSocket["onopen"] = null;
  onclose: GeminiLiveSocket["onclose"] = null;
  onmessage: GeminiLiveSocket["onmessage"] = null;
  onerror: GeminiLiveSocket["onerror"] = null;
  send(value: string) {
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function harness(callbacks: GeminiLiveCallbacks = {}) {
  const sockets: Socket[] = [];
  const conversation = new GeminiLiveConversation({
    apiKey: "fake",
    model: "gemini-3.8-live",
    callbacks,
    createSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  const connect = async () => {
    const pending = conversation.connect();
    const socket = sockets.at(-1)!;
    socket.readyState = 1;
    socket.onopen?.({});
    socket.emit({ setupComplete: {} });
    await pending;
    return socket;
  };
  return { conversation, connect, sockets };
}

describe("Gemini live session", () => {
  it("waits for setupComplete and explicitly enables transcription", async () => {
    const onOpen = vi.fn();
    const { conversation, sockets } = harness({ onOpen });
    const pending = conversation.connect();
    const socket = sockets[0]!;
    socket.readyState = 1;
    socket.onopen?.({});
    expect(onOpen).not.toHaveBeenCalled();
    expect(conversation.isConnected).toBe(false);
    expect(socket.sent[0]).toMatchObject({
      setup: {
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    });
    socket.emit({ setupComplete: {} });
    await pending;
    expect(onOpen).toHaveBeenCalledOnce();
    await conversation.disconnect();
  });

  it("sends one manual activity for an utterance", async () => {
    const { conversation, connect } = harness();
    const socket = await connect();
    conversation.sendAudio(new Uint8Array([1, 0]));
    conversation.sendAudio(new Uint8Array([2, 0]));
    conversation.finalizeInput();
    expect(socket.sent.slice(1)).toEqual([
      { realtimeInput: { activityStart: {} } },
      { realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AQA=" } } },
      { realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AgA=" } } },
      { realtimeInput: { activityEnd: {} } },
    ]);
    await conversation.disconnect();
  });

  it("cancel rejects stale tools, audio, and asynchronous frame decoding", async () => {
    const onAudio = vi.fn();
    const onToolCall = vi.fn();
    const { conversation, connect } = harness({ onAudio, onToolCall });
    const old = await connect();
    const deliver = old.onmessage!;
    deliver({
      data: JSON.stringify({
        toolCall: { functionCalls: [{ id: "old", name: "run_voice_task", args: {} }] },
      }),
    });
    conversation.cancel();
    await connect();
    deliver({
      data: new Blob([
        JSON.stringify({
          serverContent: { modelTurn: { parts: [{ inlineData: { data: "AQA=" } }] } },
        }),
      ]),
    });
    await flush();
    expect(onAudio).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    await conversation.disconnect();
  });

  it("aborts in-flight tool work on cancellation and includes the function name in results", async () => {
    const onToolCall = vi.fn();
    const { conversation, connect } = harness({ onToolCall });
    const socket = await connect();
    socket.emit({
      toolCall: {
        functionCalls: [{ id: "call", name: "run_voice_task", args: { prompt: "inspect MCP" } }],
      },
    });
    await flush();
    const signal = onToolCall.mock.calls[0]![1] as AbortSignal;
    conversation.sendToolResponse("call", { status: "accepted" });
    expect(socket.sent.at(-1)).toMatchObject({
      toolResponse: { functionResponses: [{ id: "call", name: "run_voice_task" }] },
    });
    conversation.cancel();
    expect(signal.aborted).toBe(true);
  });

  it("accumulates transcript fragments and preserves completed text after interruption", async () => {
    const onInputTranscript = vi.fn();
    const { conversation, connect } = harness({ onInputTranscript });
    const socket = await connect();
    socket.emit({ serverContent: { inputTranscription: { text: "Check " } } });
    socket.emit({
      serverContent: {
        inputTranscription: { text: "MCP" },
        outputTranscription: { text: "Checking." },
        turnComplete: true,
      },
    });
    await flush();
    expect(onInputTranscript).toHaveBeenLastCalledWith("Check MCP");
    conversation.cancel();
    const next = await connect();
    expect(next.sent[1]).toMatchObject({
      clientContent: {
        turnComplete: false,
        turns: [
          { role: "user", parts: [{ text: "Check MCP" }] },
          { role: "model", parts: [{ text: "Checking." }] },
        ],
      },
    });
    await conversation.disconnect();
  });

  it("decodes browser Blob and ArrayBuffer frames", async () => {
    await expect(decodeSocketData(new Blob(["hello"]))).resolves.toBe("hello");
    await expect(decodeSocketData(new TextEncoder().encode("hello").buffer)).resolves.toBe("hello");
  });
});

it("retains the first spoken frames while reconnecting without sending before setup", async () => {
  const { conversation, sockets } = harness();
  const ready = conversation.connect();
  const socket = sockets[0]!;
  conversation.sendAudio(new Uint8Array([1, 0]));
  socket.readyState = 1;
  socket.onopen?.({});
  expect(socket.sent).toHaveLength(1);
  socket.emit({ setupComplete: {} });
  await ready;
  conversation.finalizeInput();
  expect(socket.sent.slice(1)).toEqual([
    { realtimeInput: { activityStart: {} } },
    { realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: "AQA=" } } },
    { realtimeInput: { activityEnd: {} } },
  ]);
  await conversation.disconnect();
});
