import { describe, expect, it, vi } from "@effect/vitest";

import { connectGatewayBridge, type GatewayBridgeSocket } from "./bridgeClient.ts";
import type { GatewayRuntimePort } from "./port.ts";

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
});
