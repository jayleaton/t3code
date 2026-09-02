import * as NodeCrypto from "node:crypto";

import { WebSocketServer, type WebSocket } from "ws";

import type { GatewayRuntimePort } from "./port.ts";

interface PendingRequest {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutSignal: AbortSignal;
  readonly onTimeout: () => void;
}

function clearRequestTimeout(request: PendingRequest): void {
  request.timeoutSignal.removeEventListener("abort", request.onTimeout);
}

function proof(token: string, value: string): string {
  return NodeCrypto.createHmac("sha256", token).update(value).digest("hex");
}

function valuesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    NodeCrypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}

export function createBridgeRuntimePort(input: {
  readonly port: number;
  readonly token: string;
  readonly host?: string;
  readonly requestTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
}): {
  readonly port: GatewayRuntimePort;
  readonly close: () => Promise<void>;
} {
  if (input.token.length < 16)
    throw new Error("The gateway bridge token must contain at least 16 characters.");
  const server = new WebSocketServer({
    host: input.host ?? "127.0.0.1",
    port: input.port,
    maxPayload: 1024 * 1024,
  });
  let client: WebSocket | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  const rejectPending = (message: string) => {
    for (const request of pending.values()) {
      clearRequestTimeout(request);
      request.reject(new Error(message));
    }
    pending.clear();
  };

  server.on("connection", (socket) => {
    let authenticated = false;
    const nonce = NodeCrypto.randomBytes(32).toString("hex");
    const authenticationSignal = AbortSignal.timeout(input.authenticationTimeoutMs ?? 5_000);
    const onAuthenticationTimeout = () => {
      if (!authenticated) socket.close(1008, "Gateway bridge authentication timed out.");
    };
    authenticationSignal.addEventListener("abort", onAuthenticationTimeout, { once: true });
    socket.send(JSON.stringify({ type: "challenge", nonce }));

    socket.on("message", (raw) => {
      try {
        const response = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!authenticated) {
          const expectedClientProof = proof(input.token, `client:${nonce}`);
          if (
            response.type !== "authenticate" ||
            typeof response.proof !== "string" ||
            !valuesMatch(response.proof, expectedClientProof)
          ) {
            socket.close(1008, "Gateway bridge authentication failed.");
            return;
          }
          authenticated = true;
          authenticationSignal.removeEventListener("abort", onAuthenticationTimeout);
          if (client !== null) {
            rejectPending("T3 gateway client was replaced.");
            client.close(1012, "Replaced by a new authenticated T3 client runtime.");
          }
          client = socket;
          socket.send(
            JSON.stringify({ type: "authenticated", proof: proof(input.token, `server:${nonce}`) }),
          );
          return;
        }
        if (client !== socket || typeof response.id !== "number") return;
        const request = pending.get(response.id);
        if (request === undefined) return;
        pending.delete(response.id);
        clearRequestTimeout(request);
        if (typeof response.error !== "string") request.resolve(response.result);
        else request.reject(new Error(response.error));
      } catch {
        if (!authenticated) socket.close(1008, "Gateway bridge authentication failed.");
      }
    });
    socket.on("close", () => {
      authenticationSignal.removeEventListener("abort", onAuthenticationTimeout);
      if (client !== socket) return;
      client = null;
      rejectPending("T3 gateway client disconnected.");
    });
  });

  const invoke = (method: keyof GatewayRuntimePort, args: ReadonlyArray<unknown>): Promise<any> => {
    if (client === null || client.readyState !== client.OPEN) {
      return Promise.reject(
        new Error("No authenticated T3 client is connected to the gateway bridge."),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeoutSignal = AbortSignal.timeout(input.requestTimeoutMs ?? 30_000);
      const onTimeout = () => {
        pending.delete(id);
        reject(new Error(`Gateway bridge request ${id} timed out.`));
      };
      timeoutSignal.addEventListener("abort", onTimeout, { once: true });
      pending.set(id, { resolve, reject, timeoutSignal, onTimeout });
      client?.send(JSON.stringify({ id, method, args }));
    });
  };

  return {
    port: {
      listEnvironments: () => invoke("listEnvironments", []),
      getEnvironmentStatus: (environmentId) => invoke("getEnvironmentStatus", [environmentId]),
      listProjects: (environmentId) => invoke("listProjects", [environmentId]),
      listThreads: (environmentId) => invoke("listThreads", [environmentId]),
      getThread: (environmentId, threadId) => invoke("getThread", [environmentId, threadId]),
      createThread: (request) => invoke("createThread", [request]),
      sendMessage: (request) => invoke("sendMessage", [request]),
    },
    close: () =>
      new Promise((resolve, reject) => {
        rejectPending("Gateway stopped.");
        client?.close(1001, "Gateway stopped.");
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
