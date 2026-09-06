import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import { describe, expect, it, vi } from "@effect/vitest";
import WebSocket from "ws";

import { createBridgeRuntimePort } from "./bridge.ts";
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
        } else resolve();
        return;
      }
      if (message.type === "configured") {
        resolve();
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
    client.send(JSON.stringify({ type: "configure", grants: { stale: ["admin"] } }));
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
            environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
            providerLabel: "OpenCode",
            modelLabel: "GLM 5.3",
            instanceId: "opencode",
            model: "glm-5.3",
            reasoningEffort: "medium",
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
        environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
        providerLabel: "OpenCode",
        modelLabel: "GLM 5.3",
        instanceId: "opencode",
        model: "glm-5.3",
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);
    client.close();
    await bridge.close();
  });

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

it("enforces acknowledged grant updates when opening a remote chat through the bridge", async () => {
  const port = await unusedPort();
  const bridge = createBridgeRuntimePort({ port, token: TOKEN });
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const requests: Record<string, unknown>[] = [];
  const authenticated = authenticate(
    client,
    (request) => {
      requests.push(request);
      client.send(
        JSON.stringify({
          id: request.id,
          result: { environmentId: "remote", threadId: "chat", status: "succeeded" },
        }),
      );
    },
    false,
  );
  try {
    await opened(client);
    await authenticated;
    const configure = async (grants: Record<string, readonly string[]>) => {
      const acknowledged = new Promise<void>((resolve) => {
        client.once("message", (raw) => {
          expect(JSON.parse(raw.toString())).toEqual({ type: "configured" });
          resolve();
        });
      });
      client.send(JSON.stringify({ type: "configure", grants }));
      await acknowledged;
    };
    const context = { port: bridge.port, grants: bridge.getGrants };
    await configure({ remote: ["send"] });
    await expect(
      callGatewayTool(context, "t3_open_thread", { environmentId: "remote", threadId: "chat" }),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(requests).toEqual([]);
    await configure({ remote: ["read"] });
    await expect(
      callGatewayTool(context, "t3_open_thread", { environmentId: "remote", threadId: "chat" }),
    ).resolves.toEqual({ environmentId: "remote", threadId: "chat", status: "succeeded" });
    expect(requests).toEqual([{ id: 1, method: "openThread", args: ["remote", "chat"] }]);
    await configure({ remote: ["send"] });
    await expect(
      callGatewayTool(context, "t3_open_thread", { environmentId: "remote", threadId: "chat" }),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(requests).toHaveLength(1);
  } finally {
    client.close();
    await bridge.close();
  }
});
