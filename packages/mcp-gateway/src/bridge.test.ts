// @effect-diagnostics nodeBuiltinImport:off - exercises durable SQLite replay across a real bridge reconnect.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import WebSocket from "ws";

import { createBridgeRuntimePort } from "./bridge.ts";
import { createGatewayEventStore } from "./events.ts";
import type { GatewayMutationResult } from "./port.ts";
import { callGatewayTool } from "./tools.ts";

const TOKEN = "test-token-123456789";

function proof(value: string): string {
  return NodeCrypto.createHmac("sha256", TOKEN).update(value).digest("hex");
}

async function unusedPort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}

function authenticate(
  socket: WebSocket,
  onRequest?: (message: Record<string, unknown>) => void,
  configure = true,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let nonce: string | null = null;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "challenge" && typeof message.nonce === "string") {
        nonce = message.nonce;
        socket.send(
          JSON.stringify({ type: "authenticate", proof: proof(`client:${message.nonce}`) }),
        );
        return;
      }
      if (message.type === "authenticated") {
        if (nonce === null || message.proof !== proof(`server:${nonce}`)) {
          reject(new Error("Invalid server proof."));
          return;
        }
        if (configure) {
          socket.send(JSON.stringify({ type: "configure", grants: {} }));
          const configuredSignal = AbortSignal.timeout(10);
          configuredSignal.addEventListener("abort", () => resolve(), { once: true });
        } else resolve();
        return;
      }
      onRequest?.(message);
    });
  });
}

describe("gateway bridge", () => {
  it("rejects unauthenticated clients and serves only a mutually authenticated runtime", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}`);
    const challenged = new Promise<void>((resolve) => {
      unauthenticated.once("message", () => {
        unauthenticated.send(JSON.stringify({ type: "authenticate", proof: "wrong" }));
        resolve();
      });
    });
    await opened(unauthenticated);
    await challenged;
    await closed(unauthenticated);
    await expect(bridge.port.listEnvironments()).rejects.toThrow("No configured T3 client");

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, (message) => {
      if (message.method === "listEnvironments") {
        client.send(JSON.stringify({ id: message.id, result: [{ environmentId: "local" }] }));
      }
    });
    await opened(client);
    await authenticated;

    await expect(bridge.port.listEnvironments()).resolves.toEqual([{ environmentId: "local" }]);
    client.close();
    await bridge.close();
  });

  it("keeps the first bridge alive and reports a typed degraded result when the port is occupied", async () => {
    const port = await unusedPort();
    const first = createBridgeRuntimePort({ port, token: TOKEN });
    await expect(first.ready).resolves.toEqual({ status: "running" });

    const second = createBridgeRuntimePort({ port, token: TOKEN });
    await expect(second.ready).resolves.toMatchObject({
      status: "degraded",
      code: "address_in_use",
      port,
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, (message) => {
      if (message.method === "listEnvironments") {
        client.send(JSON.stringify({ id: message.id, result: [{ environmentId: "local" }] }));
      }
    });
    await opened(client);
    await authenticated;
    await expect(first.port.listEnvironments()).resolves.toEqual([{ environmentId: "local" }]);

    client.close();
    await second.close();
    await first.close();
  });

  it("does not activate a runtime until it supplies valid grant configuration", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({
      port,
      token: TOKEN,
      initialGrants: { stale: ["read"] },
      requestTimeoutMs: 25,
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const onRequest = vi.fn();
    const authenticated = authenticate(client, onRequest, false);
    await opened(client);
    await authenticated;

    await expect(bridge.port.listEnvironments()).rejects.toThrow("No configured T3 client");
    expect(onRequest).not.toHaveBeenCalled();

    const closedClient = closed(client);
    client.send(JSON.stringify({ type: "configure", grants: { stale: ["unknown-scope"] } }));
    await closedClient;
    await expect(bridge.port.listEnvironments()).rejects.toThrow("No configured T3 client");
    await bridge.close();
  });

  it("rejects configuration from a superseded authenticated connection", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN });
    const older = new WebSocket(`ws://127.0.0.1:${port}`);
    const olderAuthenticated = authenticate(older, undefined, false);
    await opened(older);
    await olderAuthenticated;

    const newer = new WebSocket(`ws://127.0.0.1:${port}`);
    const newerAuthenticated = authenticate(newer, undefined, false);
    await opened(newer);
    await newerAuthenticated;
    newer.send(
      JSON.stringify({
        type: "configure",
        grants: { "a534b83f-a352-44d8-aedc-c4230c179390": ["read"] },
      }),
    );
    await vi.waitFor(() =>
      expect(bridge.getGrants()).toEqual({
        "a534b83f-a352-44d8-aedc-c4230c179390": ["read"],
      }),
    );

    const olderClosed = closed(older);
    older.send(
      JSON.stringify({
        type: "configure",
        grants: { "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read", "send"] },
      }),
    );
    await olderClosed;
    expect(bridge.getGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read"],
    });

    newer.close();
    await bridge.close();
  });

  it("accepts grant configuration only from the authenticated runtime", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client, undefined, false);
    await opened(client);
    await authenticated;

    client.send(
      JSON.stringify({
        type: "configure",
        grants: {
          "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
          "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
        },
        profiles: [
          {
            name: "Andy",
            modelSelection: { instanceId: "glm", model: "glm-5.3" },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        ],
      }),
    );

    await vi.waitFor(() =>
      expect(bridge.getGrants()).toEqual({
        "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
        "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
      }),
    );
    expect(bridge.getProfiles()).toEqual([
      {
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);
    client.close();
    await bridge.close();
  });

  it("returns durable cursors and ingests events only for granted environments", async () => {
    const port = await unusedPort();
    const onEvent = vi.fn();
    const getEventCursor = vi.fn((environmentId: string) =>
      environmentId === "granted" ? 41 : 99,
    );
    const bridge = createBridgeRuntimePort({
      port,
      token: TOKEN,
      onEvent,
      getEventCursor,
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: Array<Record<string, unknown>> = [];
    const authenticated = authenticate(client, (message) => messages.push(message), false);
    await opened(client);
    await authenticated;
    client.send(JSON.stringify({ type: "configure", grants: { granted: ["read"] } }));

    await vi.waitFor(() =>
      expect(messages).toContainEqual({ type: "configured", cursors: { granted: 41 } }),
    );
    expect(getEventCursor).toHaveBeenCalledTimes(1);
    expect(getEventCursor).toHaveBeenCalledWith("granted");

    client.send(
      JSON.stringify({
        type: "event",
        event: {
          environmentId: "denied",
          eventId: "e-1",
          sequence: 100,
          type: "thread.progress",
          occurredAt: "2026-09-04T00:00:00.000Z",
        },
      }),
    );
    client.send(
      JSON.stringify({
        type: "event",
        event: {
          environmentId: "granted",
          eventId: "e-2",
          sequence: 42,
          type: "thread.progress",
          occurredAt: "2026-09-04T00:00:01.000Z",
        },
      }),
    );
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "granted", eventId: "e-2", sequence: 42 }),
    );

    client.close();
    await bridge.close();
  });

  it.each(["accept", "acceptForSession"] as const)(
    "recovers one authoritative %s side effect after a real bridge disconnect and store reopen",
    async (decision) => {
      const port = await unusedPort();
      const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 100 });
      await bridge.ready;
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-replay-"));
      const file = NodePath.join(directory, "events.sqlite");
      let events = createGatewayEventStore({ file });
      let pending = true;
      let sideEffects = 0;
      const receipts = new Map<string, GatewayMutationResult>();
      const thread = () => ({
        id: "thread-1",
        activities: pending
          ? [
              {
                id: "approval-1",
                sequence: 1,
                kind: "approval.requested",
                payload: {
                  requestId: "approval-1",
                  requestKind: "command",
                  detail: "Run command",
                },
              },
            ]
          : [
              {
                id: "approval-1",
                sequence: 1,
                kind: "approval.requested",
                payload: {
                  requestId: "approval-1",
                  requestKind: "command",
                  detail: "Run command",
                },
              },
              {
                id: "approval-resolved-1",
                sequence: 2,
                kind: "approval.resolved",
                payload: { requestId: "approval-1" },
              },
            ],
      });
      let disconnectAfterAcceptance = true;
      const connectRuntime = async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        const authenticated = authenticate(
          socket,
          (message) => {
            const id = message.id;
            const args = message.args as ReadonlyArray<Record<string, unknown>> | undefined;
            if (message.method === "getThread") {
              socket.send(JSON.stringify({ id, result: thread() }));
              return;
            }
            if (message.method !== "respondToApproval") return;
            const request = args?.[0];
            const requestId = String(request?.requestId ?? "");
            const previous = receipts.get(requestId);
            if (previous !== undefined) {
              socket.send(JSON.stringify({ id, result: previous }));
              return;
            }
            sideEffects += 1;
            pending = false;
            const receipt = {
              requestId,
              commandId: requestId,
              status: "accepted" as const,
              threadId: String(request?.threadId ?? ""),
            };
            receipts.set(requestId, receipt);
            if (disconnectAfterAcceptance) socket.close(1012, "injected response loss");
            else socket.send(JSON.stringify({ id, result: receipt }));
          },
          false,
        );
        await opened(socket);
        await authenticated;
        socket.send(JSON.stringify({ type: "configure", grants: { local: ["read", "approval"] } }));
        await vi.waitFor(() => expect(bridge.getHealth().bridge).toBe("connected"));
        expect(bridge.getGrants()).toEqual({ local: ["read", "approval"] });
        return socket;
      };
      let runtime = await connectRuntime();
      const request = {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision,
        confirmDestructive: true,
        idempotencyKey: `bridge-lost-${decision}`,
      };
      try {
        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            "t3_respond_to_approval",
            request,
          ),
        ).rejects.toThrow("disconnected");
        events.close();
        events = createGatewayEventStore({ file });
        disconnectAfterAcceptance = false;
        runtime = await connectRuntime();

        await expect(
          callGatewayTool(
            { port: bridge.port, grants: bridge.getGrants, events },
            "t3_respond_to_approval",
            request,
          ),
        ).resolves.toEqual(receipts.get(`mcp-request-${request.idempotencyKey}`));
        expect(sideEffects).toBe(1);
      } finally {
        runtime.close();
        events.close();
        await bridge.close();
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("times out requests that receive no runtime response", async () => {
    const port = await unusedPort();
    const bridge = createBridgeRuntimePort({ port, token: TOKEN, requestTimeoutMs: 10 });
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    const authenticated = authenticate(client);
    await opened(client);
    await authenticated;

    await expect(bridge.port.listEnvironments()).rejects.toThrow("timed out");
    client.close();
    await bridge.close();
  });
});
