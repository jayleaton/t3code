import { describe, expect, it, vi } from "vite-plus/test";

import {
  decodeSocketData,
  GeminiLiveConversation,
  respondToToolCall,
} from "./geminiLiveConversation.ts";
import type { GeminiLiveCallbacks, GeminiLiveSocket } from "./geminiLiveConversation.ts";

const EXPECTED_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=test-api-key";

class FakeSocket implements GeminiLiveSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
  }

  open(): void {
    this.onopen?.({});
  }

  emitMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  emitClose(event: { readonly code: number; readonly reason: string }): void {
    this.onclose?.(event);
  }
}

interface Harness {
  readonly conversation: GeminiLiveConversation;
  readonly socket: FakeSocket;
  readonly urls: string[];
}

function createHarness(callbacks?: GeminiLiveCallbacks): Harness {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const conversation = new GeminiLiveConversation({
    apiKey: "test-api-key",
    model: "gemini-2.0-flash-live-001",
    ...(callbacks === undefined ? {} : { callbacks }),
    createSocket: (url) => {
      urls.push(url);
      return socket;
    },
  });
  return { conversation, socket, urls };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function decodeBase64ForTest(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64ForTest(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function countFrames(socket: FakeSocket, marker: string): number {
  return socket.sent.filter((frame) => frame.includes(marker)).length;
}

function parsedFrames(socket: FakeSocket): ReadonlyArray<Record<string, unknown>> {
  return socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

describe("GeminiLiveConversation", () => {
  it("connect() opens the documented socket and sends the audio setup", async () => {
    const { conversation, socket, urls } = createHarness();

    await conversation.connect();

    expect(urls).toEqual([EXPECTED_URL]);
    expect(socket.sent).toHaveLength(1);
    const setup = asRecord(parsedFrames(socket)[0]?.["setup"]);
    expect(setup["model"]).toBe("models/gemini-2.0-flash-live-001");
    expect(asRecord(setup["generationConfig"])["responseModalities"]).toEqual(["AUDIO"]);
  });

  it("sendAudio() opens the utterance once and round-trips the PCM bytes", async () => {
    const { conversation, socket } = createHarness();
    await conversation.connect();
    const chunk = new Uint8Array([0, 1, 2, 3, 250, 255]);

    conversation.sendAudio(chunk);
    conversation.sendAudio(new Uint8Array([9, 8, 7]));

    expect(countFrames(socket, '"activityStart"')).toBe(1);
    const audio = asRecord(parsedFrames(socket)[2]?.["realtimeInput"]);
    const audioPayload = asRecord(audio["audio"]);
    expect(audioPayload["mimeType"]).toBe("audio/pcm;rate=16000");
    expect(decodeBase64ForTest(audioPayload["data"] as string)).toEqual(chunk);
    expect(conversation.activityOpen).toBe(true);
  });

  it("finalizeInput() ends the utterance exactly once", async () => {
    const { conversation, socket } = createHarness();
    await conversation.connect();
    conversation.sendAudio(new Uint8Array([1, 2]));

    conversation.finalizeInput();
    conversation.finalizeInput();

    expect(countFrames(socket, '"activityEnd"')).toBe(1);
    expect(conversation.activityOpen).toBe(false);
  });

  it("dispatches decoded audio, transcripts, and turn completion", async () => {
    const onAudio = vi.fn();
    const onInputTranscript = vi.fn();
    const onOutputTranscript = vi.fn();
    const onTurnComplete = vi.fn();
    const { conversation, socket } = createHarness({
      onAudio,
      onInputTranscript,
      onOutputTranscript,
      onTurnComplete,
    });
    await conversation.connect();
    const chunk = new Uint8Array([10, 20, 30, 40]);

    socket.emitMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm", data: encodeBase64ForTest(chunk) } }],
        },
        inputTranscription: { text: "what is the status" },
        outputTranscription: { text: "all agents are running" },
        turnComplete: true,
      },
    });
    await flush();

    expect(onAudio).toHaveBeenCalledWith(chunk);
    expect(onInputTranscript).toHaveBeenCalledWith("what is the status");
    expect(onOutputTranscript).toHaveBeenCalledWith("all agents are running");
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it("dispatches tool calls and serializes tool responses", async () => {
    const onToolCall = vi.fn();
    const { conversation, socket } = createHarness({ onToolCall });
    await conversation.connect();

    socket.emitMessage({
      toolCall: {
        functionCalls: [{ id: "call-1", name: "list_projects", args: { archived: false } }],
      },
    });
    await flush();

    expect(onToolCall).toHaveBeenCalledWith({
      id: "call-1",
      name: "list_projects",
      args: { archived: false },
    });
    expect(JSON.parse(respondToToolCall("call-1", { projects: ["alpha"] }))).toEqual({
      toolResponse: {
        functionResponses: [{ id: "call-1", response: { result: { projects: ["alpha"] } } }],
      },
    });
  });

  it("tracks connection state and reports socket close", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const { conversation, socket } = createHarness({ onOpen, onClose });
    await conversation.connect();

    expect(conversation.isConnected).toBe(false);
    socket.open();
    expect(conversation.isConnected).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);

    socket.emitClose({ code: 1000, reason: "done" });
    expect(conversation.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: "done" });
  });

  it("cancel() ends an open activity and disconnect() is safe to repeat", async () => {
    const { conversation, socket } = createHarness();
    await conversation.connect();
    conversation.sendAudio(new Uint8Array([1, 2]));

    conversation.cancel();
    expect(countFrames(socket, '"activityEnd"')).toBe(1);
    expect(conversation.activityOpen).toBe(false);
    expect(socket.closeCalls).toBe(1);

    conversation.cancel();
    expect(socket.closeCalls).toBe(1);

    await conversation.disconnect();
    await conversation.disconnect();
    expect(socket.closeCalls).toBe(1);
  });

  it("decodeSocketData() decodes ArrayBuffer frames", async () => {
    const encoded = new TextEncoder().encode('{"setupComplete":{}}');

    await expect(decodeSocketData(encoded.buffer)).resolves.toBe('{"setupComplete":{}}');
  });
});
