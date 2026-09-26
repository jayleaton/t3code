/* oxlint-disable unicorn/prefer-add-event-listener -- The MCP Transport interface uses callback properties, not DOM events. */
// @effect-diagnostics-next-line nodeBuiltinImport:off - A detached owner must outlive any one stdio client, including on Windows.
import * as NodeChildProcess from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { sharedGatewayConfiguration, type SharedGatewayConfig } from "./sharedOwner.ts";
import {
  connectMcpSession,
  GatewayRetiredError,
  GatewayUnavailableError,
} from "./sharedTransport.ts";

/** Connection attempts while a retiring owner releases the port to a fresh one. */
const CONNECT_ATTEMPTS = 20;
const RETIRE_RETRY_MS = 100;

export function launchSharedOwner(
  entryPoint: string,
  config: SharedGatewayConfig,
): Promise<NodeChildProcess.ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        ...process.execArgv.filter((arg) => !arg.startsWith("--inspect")),
        entryPoint,
        "--shared-owner",
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...process.env,
          T3_MCP_BRIDGE_PORT: String(config.port),
          T3_MCP_BRIDGE_TOKEN: config.token,
          T3_MCP_STATE_FILE: config.stateFile,
          T3_MCP_EVENT_RETENTION: String(config.retentionEvents),
          T3_MCP_REPOSITORY_ALLOWLIST: config.repositoryAllowlist.join(","),
          T3_MCP_GRANTS: JSON.stringify(config.initialGrants),
        },
      },
    );
    const timeout = AbortSignal.timeout(15_000);
    const cleanup = () => {
      timeout.removeEventListener("abort", onTimeout);
      child.off("error", fail);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const fail = (error: Error) => {
      cleanup();
      child.kill();
      if (child.connected) child.disconnect();
      reject(error);
    };
    const onTimeout = () => fail(new Error("Timed out starting the shared MCP gateway owner."));
    const onExit = (code: number | null) =>
      fail(new Error(`Shared MCP gateway owner exited before startup (code ${code}).`));
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value)) return;
      if (value.type === "error" && "message" in value && typeof value.message === "string") {
        fail(new Error(value.message));
      } else if (value.type === "ready") {
        cleanup();
        if (child.connected) child.disconnect();
        child.unref();
        resolve(child);
      }
    };
    timeout.addEventListener("abort", onTimeout, { once: true });
    child.once("error", fail);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

export async function connectSharedGateway(
  config: SharedGatewayConfig,
  launch: () => Promise<void>,
): Promise<Transport> {
  const input = {
    port: config.port,
    token: config.token,
    configuration: sharedGatewayConfiguration(config),
    ...(config.build === undefined ? {} : { build: config.build }),
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await connectMcpSession(input);
    } catch (error) {
      const retired = error instanceof GatewayRetiredError;
      if (!retired && !(error instanceof GatewayUnavailableError)) throw error;
      if (attempt >= CONNECT_ATTEMPTS) throw error;
      // A retired owner releases the port as it closes, so connect again rather
      // than launching into a port it may still hold.
      if (retired) {
        await new Promise((resolve) =>
          AbortSignal.timeout(RETIRE_RETRY_MS).addEventListener("abort", resolve, { once: true }),
        );
        continue;
      }
    }
    await launch();
  }
}

const isRequest = (message: JSONRPCMessage) => "method" in message && "id" in message;
const isResponse = (message: JSONRPCMessage) => "id" in message && !("method" in message);
const RECONNECT_INITIALIZE_ID = "t3-gateway-reconnect";

/**
 * Proxy complete MCP messages, keeping request ids and notifications scoped to
 * this session. When the owner stops (an update retired it, or it crashed) and
 * `reconnect` is given, the session moves to the next owner: calls in flight
 * fail with a retry hint, the client's initialize handshake is replayed, and
 * the client is told the tool list changed so it picks up the new build's tools.
 */
export async function proxyMcpStdio(
  initial: Transport,
  reconnect?: () => Promise<Transport>,
): Promise<void> {
  const stdio = new StdioServerTransport();
  let remote = initial;
  let stopping = false;
  let initialize: JSONRPCMessage | undefined;
  let initialized: JSONRPCMessage | undefined;
  const inFlight = new Set<string | number>();
  // Messages the client sends while the session moves to the next owner.
  let held: JSONRPCMessage[] | undefined;
  const report = (error: Error) => {
    process.stderr.write(`t3-mcp-gateway: ${error.message}\n`);
    process.exitCode = 1;
    void shutdown();
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.stdin.off("end", onEnd);
    process.off("SIGINT", onEnd);
    process.off("SIGTERM", onEnd);
    await Promise.allSettled([stdio.close(), remote.close()]);
  };
  const onEnd = () => {
    void shutdown();
  };
  const forward = (message: JSONRPCMessage) => {
    if (isRequest(message)) inFlight.add((message as { id: string | number }).id);
    void remote.send(message).catch(report);
  };
  const attach = async (transport: Transport, onReplayed?: () => void) => {
    remote = transport;
    transport.onmessage = (message) => {
      if (isResponse(message) && (message as { id: unknown }).id === RECONNECT_INITIALIZE_ID) {
        onReplayed?.();
        return;
      }
      if (isResponse(message)) inFlight.delete((message as { id: string | number }).id);
      void stdio.send(message).catch(report);
    };
    transport.onerror = report;
    transport.onclose = () => {
      if (stopping || transport !== remote) return;
      void moveToNextOwner();
    };
    await transport.start();
  };
  const moveToNextOwner = async () => {
    for (const id of inFlight) {
      void stdio
        .send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: "The T3 gateway restarted during this call. Retry it.",
          },
        })
        .catch(() => undefined);
    }
    inFlight.clear();
    if (reconnect === undefined || initialize === undefined) {
      report(
        new Error(
          "Shared gateway owner stopped. Reconnect this MCP session; in-flight work is not automatically replayed.",
        ),
      );
      return;
    }
    held = [];
    try {
      const next = await reconnect();
      const replayed = Promise.withResolvers<void>();
      await attach(next, replayed.resolve);
      await next.send({ ...initialize, id: RECONNECT_INITIALIZE_ID } as JSONRPCMessage);
      await replayed.promise;
      if (initialized !== undefined) await next.send(initialized);
      const pending = held;
      held = undefined;
      for (const message of pending) forward(message);
      await stdio.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
    }
  };
  process.stdin.once("end", onEnd);
  process.once("SIGINT", onEnd);
  process.once("SIGTERM", onEnd);
  stdio.onmessage = (message) => {
    if ("method" in message && message.method === "initialize") initialize = message;
    if ("method" in message && message.method === "notifications/initialized") {
      initialized = message;
    }
    if (held !== undefined) held.push(message);
    else forward(message);
  };
  stdio.onerror = report;
  await attach(initial);
  await stdio.start();
}
