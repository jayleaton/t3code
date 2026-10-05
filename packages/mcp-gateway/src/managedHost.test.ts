/* oxlint-disable unicorn/prefer-add-event-listener -- MCP servers expose callback properties. */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  InitializedNotificationSchema,
  InitializeRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
