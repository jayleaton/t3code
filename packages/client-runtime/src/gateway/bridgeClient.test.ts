import { describe, expect, it, vi } from "@effect/vitest";

import { connectGatewayBridge, type GatewayBridgeSocket } from "./bridgeClient.ts";

async function proof(token: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
import type { GatewayRuntimeEventSource, GatewayRuntimePort } from "./port.ts";

class FakeSocket implements GatewayBridgeSocket {
  readonly OPEN = 1;
  readonly readyState = 1;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<
    string,
    Array<(event: { readonly data?: string }) => void>
  >();

  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event = data === undefined ? {} : { data };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const unusedPort = {
  listEnvironments: vi.fn(async () => []),
} as unknown as GatewayRuntimePort;

describe("gateway bridge client", () => {
  it("does not execute runtime operations before mutual authentication", async () => {
    const socket = new FakeSocket();
    const bridge = connectGatewayBridge({
      port: unusedPort,
      token: "test-token-123456789",
      url: "ws://127.0.0.1:47631",
      createSocket: () => socket,
    });

    socket.emit("message", JSON.stringify({ id: 1, method: "listEnvironments", args: [] }));
    await vi.waitFor(() => expect(socket.closed).toBe(true));

    expect(unusedPort.listEnvironments).not.toHaveBeenCalled();
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      id: -1,
      error: "Gateway bridge is not authenticated.",
    });
    bridge.stop();
  });

  it("sends exact persisted environment grants only after mutual authentication", async () => {
    const socket = new FakeSocket();
    const token = "test-token-123456789";
    const grants = {
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"] as const,
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] as const,
    };
    const profiles = [
      {
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      },
    ];
    const onState = vi.fn();
    const bridge = connectGatewayBridge({
      port: unusedPort,
      token,
      grants,
      profiles,
      url: "ws://127.0.0.1:47631",
      createSocket: () => socket,
      onState,
    });
    const nonce = "a".repeat(64);

    socket.emit("message", JSON.stringify({ type: "challenge", nonce }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent.map((message) => JSON.parse(message))).not.toContainEqual({
      type: "configure",
      grants,
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "authenticated",
        proof: await proof(token, `server:${nonce}`),
      }),
    );

    await vi.waitFor(() =>
      expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
        type: "configure",
        grants,
        profiles,
      }),
    );
    expect(onState).toHaveBeenCalledWith("running");
    bridge.stop();
  });

  it("forwards authoritative receipt and message lookup methods", async () => {
    const socket = new FakeSocket();
    const token = "test-token-123456789";
    const getCommandReceipts = vi.fn(async () => [{ commandId: "command-1" }]);
    const hasThreadMessage = vi.fn(async () => true);
    const bridge = connectGatewayBridge({
      port: {
        ...unusedPort,
        getCommandReceipts,
        hasThreadMessage,
      } as unknown as GatewayRuntimePort,
      token,
      url: "ws://127.0.0.1:47631",
      createSocket: () => socket,
    });
    const nonce = "c".repeat(64);
    socket.emit("message", JSON.stringify({ type: "challenge", nonce }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emit(
      "message",
      JSON.stringify({ type: "authenticated", proof: await proof(token, `server:${nonce}`) }),
    );
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    socket.emit(
      "message",
      JSON.stringify({ id: 1, method: "getCommandReceipts", args: ["local", ["command-1"]] }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        id: 2,
        method: "hasThreadMessage",
        args: ["local", "thread-1", "message-1"],
      }),
    );

    await vi.waitFor(() => expect(socket.sent).toHaveLength(4));
    expect(getCommandReceipts).toHaveBeenCalledWith("local", ["command-1"]);
    expect(hasThreadMessage).toHaveBeenCalledWith("local", "thread-1", "message-1");
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        { id: 1, result: [{ commandId: "command-1" }] },
        { id: 2, result: true },
      ]),
    );
    bridge.stop();
  });

  it("subscribes only readable environments from durable sidecar cursors", async () => {
    const socket = new FakeSocket();
    const token = "test-token-123456789";
    const subscribe = vi.fn<GatewayRuntimeEventSource["subscribe"]>(() => () => undefined);
    const events = { subscribe } as unknown as GatewayRuntimeEventSource;
    const bridge = connectGatewayBridge({
      port: unusedPort,
      events,
      token,
      grants: { granted: ["read"], webhookOnly: ["delivery"] },
      url: "ws://127.0.0.1:47631",
      createSocket: () => socket,
    });
    const nonce = "b".repeat(64);

    socket.emit("message", JSON.stringify({ type: "challenge", nonce }));
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.emit(
      "message",
      JSON.stringify({ type: "authenticated", proof: await proof(token, `server:${nonce}`) }),
    );
    await vi.waitFor(() =>
      expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
        type: "configure",
        grants: { granted: ["read"], webhookOnly: ["delivery"] },
        profiles: [],
      }),
    );
    expect(subscribe).not.toHaveBeenCalled();

    socket.emit(
      "message",
      JSON.stringify({
        type: "configured",
        cursors: { granted: 41, webhookOnly: 99 },
      }),
    );

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    expect(subscribe.mock.calls[0]?.[1]).toEqual({
      environmentIds: ["granted"],
      afterSequenceByEnvironment: { granted: 41 },
    });
    bridge.stop();
  });
});
