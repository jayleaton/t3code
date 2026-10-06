/* oxlint-disable unicorn/prefer-add-event-listener -- MCP servers expose callback properties. */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  InitializedNotificationSchema,
  InitializeRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as NodeStream from "node:stream";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { createManagedGatewayHost } from "./managedHost.ts";

const { createTransport } = vi.hoisted(() => ({ createTransport: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(function () {
    return createTransport();
  }),
}));

const launch = { command: "test-gateway", args: [], env: {} };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  vi.useRealTimers();
  createTransport.mockReset();
});

function session() {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "gateway-test", version: "1.0.0" });
  const ready = Promise.withResolvers<void>();
  server.setNotificationHandler(InitializedNotificationSchema, () => ready.resolve());
  cleanup.push(() => server.close());
  createTransport.mockImplementationOnce(() => {
    void server.connect(transport);
    return client;
  });
  return { server, ready: ready.promise };
}

it("restarts an exited launcher and stops supervising when disabled", async () => {
  vi.useFakeTimers();
  const first = session();
  const host = await createManagedGatewayHost(launch);
  cleanup.push(host.close);
  await first.ready;
  const second = session();
  await first.server.close();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(createTransport).toHaveBeenCalledTimes(2);
  await second.ready;
  await host.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(createTransport).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces a connected launcher that stops answering MCP pings", async () => {
  vi.useFakeTimers();
  const first = session();
  const ping = Promise.withResolvers<void>();
  first.server.setRequestHandler(PingRequestSchema, async () => {
    ping.resolve();
    return new Promise((resolve) => {
      first.server.onclose = () => resolve({});
    });
  });
  const host = await createManagedGatewayHost(launch);
  cleanup.push(host.close);
  const second = session();
  await vi.advanceTimersByTimeAsync(15_000);
  await ping.promise;
  expect(createTransport).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(createTransport).toHaveBeenCalledTimes(2);
  await second.ready;
});

it("retries failed relaunches without leaving another host running", async () => {
  vi.useFakeTimers();
  const first = session();
  const host = await createManagedGatewayHost(launch);
  cleanup.push(host.close);
  createTransport.mockImplementationOnce(() => {
    throw new Error("Executable temporarily unavailable");
  });
  const second = session();
  await first.server.close();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(createTransport).toHaveBeenCalledTimes(3);
  await second.ready;
});

it("backs off relaunches an owner keeps rejecting instead of spawning one every second", async () => {
  vi.useFakeTimers();
  const first = session();
  const host = await createManagedGatewayHost(launch);
  cleanup.push(host.close);
  createTransport.mockImplementation(() => {
    throw new Error("State file or configuration mismatch");
  });
  await first.server.close();
  await vi.advanceTimersByTimeAsync(61_000);
  // Relaunches at 1, 3, 7, 15, 31 and 61 seconds, then every 30 seconds.
  expect(createTransport).toHaveBeenCalledTimes(7);
  const recovered = session();
  await vi.advanceTimersByTimeAsync(30_000);
  await recovered.ready;
  expect(createTransport).toHaveBeenCalledTimes(8);
});

function rejectedLaunch(chunks: ReadonlyArray<string>) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  const stderr = new NodeStream.PassThrough();
  createTransport.mockImplementationOnce(() => {
    setImmediate(() => {
      for (const chunk of chunks) stderr.write(chunk);
      setImmediate(() => void server.close());
    });
    return Object.assign(client, { stderr });
  });
}

it.each([
  {
    name: "a reason split across chunks with a CRLF ending",
    chunks: ["noise\nt3-mcp-", "gateway: State file or config", "uration mismatch\r\n", "after\n"],
    reason: "State file or configuration mismatch",
  },
  {
    name: "an unterminated final line",
    chunks: ["t3-mcp-gateway: first\n", "t3-mcp-gateway: Timed out ", "starting the owner"],
    reason: "Timed out starting the owner",
  },
  {
    name: "a reason after an oversized line",
    chunks: [`t3-mcp-gateway: ${"x".repeat(5_000)}`, "y\nt3-mcp-gateway: Port in use\n"],
    reason: "Port in use",
  },
])("reports the launcher's exact reason from $name", async ({ chunks, reason }) => {
  rejectedLaunch(chunks);
  const error = await createManagedGatewayHost(launch).catch((cause: Error) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(reason);
});

it("reports initial startup failure and cancels recovery", async () => {
  vi.useFakeTimers();
  createTransport.mockImplementationOnce(() => {
    throw new Error("Cannot launch gateway");
  });
  await expect(createManagedGatewayHost(launch)).rejects.toThrow("Cannot launch gateway");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(createTransport).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a responsive launcher running through repeated health checks", async () => {
  vi.useFakeTimers();
  session();
  const host = await createManagedGatewayHost(launch);
  cleanup.push(host.close);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(createTransport).toHaveBeenCalledOnce();
});

it("cancels a relaunch still waiting for initialization when disabled", async () => {
  vi.useFakeTimers();
  const first = session();
  const host = await createManagedGatewayHost(launch);
  cleanup.push(host.close);
  const second = session();
  const initializing = Promise.withResolvers<void>();
  second.server.setRequestHandler(InitializeRequestSchema, () => {
    initializing.resolve();
    return new Promise<never>((_, reject) => {
      second.server.onclose = () => reject(new Error("Closed during initialization"));
    });
  });
  await first.server.close();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(createTransport).toHaveBeenCalledTimes(2);
  await initializing.promise;
  await host.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(createTransport).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
