// @effect-diagnostics nodeBuiltinImport:off - Integration coverage uses real loopback sockets, temporary state, and child processes.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createBridgeRuntimePort, type GatewayGrants } from "./bridge.ts";
import { connectSharedGateway, launchSharedOwner } from "./sharedLauncher.ts";
import {
  sharedGatewayConfiguration,
  startSharedGatewayOwner,
  type SharedGatewayConfig,
} from "./sharedOwner.ts";
import { connectMcpSession } from "./sharedTransport.ts";
import { resolveMcpGatewayLaunchConfig } from "../../../apps/desktop/src/mcpGatewayLaunchConfig.ts";
import { buildMcpGatewayHostConfig } from "../../../apps/web/src/mcpGatewayLaunchConfig.ts";
import { createManagedGatewayHost } from "./managedHost.ts";
import * as GatewayBroker from "../../../apps/server/src/mcp/McpGatewayBroker.ts";
import { handler as gatewayHttpHandler } from "../../../apps/server/src/mcp/McpGatewayHttpServer.ts";
import { McpSessionRegistry } from "../../../apps/server/src/mcp/McpSessionRegistry.ts";

const decodeJsonMessage = Schema.decodeUnknownEffect(Schema.JsonObject);
const encodeJsonMessage = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));

const TOKEN = "test-shared-gateway-token";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
}, 45_000);

async function config(): Promise<SharedGatewayConfig> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-shared-gateway-"));
  cleanup.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  return {
    port: address.port,
    token: TOKEN,
    stateFile: NodePath.join(directory, "events.sqlite"),
    repositoryAllowlist: ["jayleaton/t3code"],
    initialGrants: {},
    retentionEvents: 1_000,
  };
}

async function owner(
  input: SharedGatewayConfig,
  options?: Parameters<typeof startSharedGatewayOwner>[1],
) {
  const instance = await startSharedGatewayOwner(input, options);
  if (instance !== undefined) cleanup.push(instance.close);
  return instance;
}

async function mcp(
  input: SharedGatewayConfig,
  launch = async () => {
    await owner(input);
  },
) {
  const client = new Client({ name: "shared-gateway-test", version: "1.0.0" });
  const transport = await connectSharedGateway(input, launch);
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

type RuntimeRequest = { id: number; method: string; args: Array<unknown> };
async function runtime(
  input: SharedGatewayConfig,
  onRequest?: (request: RuntimeRequest, reply: (result: unknown) => void) => void,
) {
  const socket = new WebSocket(`ws://127.0.0.1:${input.port}`);
  cleanup.push(() => {
    socket.terminate();
  });
  let configured: (() => void) | undefined;
  const configure = (grants: GatewayGrants) =>
    new Promise<void>((resolve) => {
      configured = resolve;
      socket.send(JSON.stringify({ type: "configure", grants }));
    });
  const ready = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "challenge") {
        socket.send(
          JSON.stringify({
            type: "authenticate",
            proof: NodeCrypto.createHmac("sha256", TOKEN)
              .update(`client:${message.nonce}`)
              .digest("hex"),
          }),
        );
      } else if (message.type === "authenticated") {
        void configure({ local: ["read", "send", "delivery"] }).then(resolve);
      } else if (message.type === "configured") {
        configured?.();
      } else if (typeof message.id === "number") {
        const reply = (result: unknown) => socket.send(JSON.stringify({ id: message.id, result }));
        if (onRequest !== undefined) onRequest(message, reply);
        else if (message.method === "listEnvironments")
          reply([
            {
              environmentId: "local",
              label: "Local",
              connectionState: "connected",
              targetKind: "primary",
            },
            {
              environmentId: "excluded",
              label: "Excluded",
              connectionState: "connected",
              targetKind: "remote",
            },
          ]);
        else reply({ environmentId: "local", connectionState: "connected" });
      }
    });
  });
  await ready;
  return { socket, configure };
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as { data?: unknown; error?: { code: string } };
}

describe("shared MCP gateway", () => {
  it.effect(
    "gives local and remote managed sessions tools through authenticated provider endpoints and withdraws them on disable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Effect.promise(config);
          const entryPoint =
            process.env.T3_MCP_TEST_ENTRYPOINT ??
            NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
          const launch = resolveMcpGatewayLaunchConfig({
            isPackaged: true,
            executablePath: process.env.T3_MCP_TEST_EXECUTABLE ?? process.execPath,
            resourcesPath: NodePath.dirname(entryPoint),
            stateFile: input.stateFile,
          })!;
          const crypto = Crypto.make({
            randomBytes: NodeCrypto.randomBytes,
            digest: () => Effect.die("unused"),
          });
          const brokers = yield* Effect.all(
            [0, 1].map(() => GatewayBroker.make.pipe(Effect.provideService(Crypto.Crypto, crypto))),
          );
          type DesktopEvent = Parameters<typeof createManagedGatewayHost>[1] extends (
            event: infer E,
          ) => void
            ? E
            : never;
          const desktopEvents = yield* Queue.unbounded<DesktopEvent>();
          const managed = yield* Effect.promise(() =>
            createManagedGatewayHost(
              {
                ...launch,
                args: [entryPoint],
                env: {
                  ...launch.env,
                  T3_MCP_BRIDGE_TOKEN: input.token,
                  T3_MCP_BRIDGE_PORT: String(input.port),
                  T3CODE_HOME: NodePath.dirname(input.stateFile),
                },
              },
              (event) => {
                Queue.offerUnsafe(desktopEvents, event);
              },
            ),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => managed.close()));
          const desktop = yield* Effect.promise(() => runtime(input));
          const ownerClosed = new Promise<void>((resolve) =>
            desktop.socket.once("close", () => resolve()),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await managed.close();
              await ownerClosed;
            }),
          );
          yield* Stream.fromQueue(desktopEvents).pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                const [index, connectionId, sessionId] = event.sessionId.split(":");
                if (!connectionId || !sessionId) return;
                const message = event.message ? yield* decodeJsonMessage(event.message) : undefined;
                yield* brokers[Number(index)]!.respond("desktop", {
                  connectionId,
                  sessionId,
                  ...(message ? { message } : {}),
                  ...(event.error ? { error: event.error } : {}),
                }).pipe(Effect.ignore);
              }),
            ),
            Effect.forkScoped,
          );
          const clients: Client[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await Promise.all(clients.map((client) => client.close()));
            }),
          );
          const relays = [];
          for (const [index, broker] of brokers.entries()) {
            const ready = yield* Deferred.make<void>();
            const relay = yield* broker.connect("desktop").pipe(
              Stream.runForEach((event) => {
                if (event.type === "connected") return Deferred.succeed(ready, undefined);
                const id = `${index}:${event.connectionId}:${event.sessionId}`;
                return Effect.promise(() =>
                  event.type === "close"
                    ? managed.closeSession(id)
                    : managed.send(id, event.message),
                );
              }),
              Effect.forkScoped,
            );
            relays.push(relay);
            yield* Deferred.await(ready);
            const credential = `provider-token-${index}`;
            const scope = {
              environmentId: EnvironmentId.make(index === 0 ? "local" : "remote"),
              threadId: ThreadId.make(`thread-${index}`),
              providerSessionId: `provider-${index}`,
              providerInstanceId: ProviderInstanceId.make("opencode"),
              capabilities: new Set(["gateway"] as const),
              issuedAt: 1,
            };
            const registry: McpSessionRegistry["Service"] = {
              resolve: (token) => Effect.succeed(token === credential ? scope : undefined),
              issue: () => Effect.die("unused"),
              touch: () => Effect.void,
              revokeThread: () => Effect.void,
              revokeProviderSession: () => Effect.void,
              revokeAll: Effect.void,
            };
            const httpRequests = yield* Queue.unbounded<{
              request: Request;
              resolve: (response: Response) => void;
              reject: (error: unknown) => void;
            }>();
            yield* Stream.fromQueue(httpRequests).pipe(
              Stream.runForEach((request) =>
                gatewayHttpHandler.pipe(
                  Effect.provideService(McpSessionRegistry, registry),
                  Effect.provideService(GatewayBroker.McpGatewayBroker, broker),
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(request.request),
                  ),
                  Effect.match({
                    onFailure: request.reject,
                    onSuccess: (response) => request.resolve(HttpServerResponse.toWeb(response)),
                  }),
                ),
              ),
              Effect.forkScoped,
            );
            const fetchEndpoint: typeof fetch = (url, init) =>
              new Promise((resolve, reject) => {
                Queue.offerUnsafe(httpRequests, {
                  request: new Request(url, init),
                  resolve,
                  reject,
                });
              });
            expect(
              (yield* Effect.promise(() =>
                fetchEndpoint("http://provider.test/mcp/gateway", { method: "POST", body: "{}" }),
              )).status,
            ).toBe(401);
            const client = new Client({ name: `managed-${index}`, version: "1.0.0" });
            clients.push(client);
            yield* Effect.promise(() =>
              client.connect(
                new StreamableHTTPClientTransport(new URL("http://provider.test/mcp/gateway"), {
                  fetch: fetchEndpoint,
                  requestInit: { headers: { Authorization: `Bearer ${credential}` } },
                  // SDK getter is string | undefined while Transport declares an exact optional property.
                }) as Transport,
              ),
            );
          }
          yield* Effect.promise(async () => {
            for (const client of clients) {
              expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                  "t3_create_thread",
                  "t3_create_agent",
                  "t3_get_agents_view",
                  "t3_control_thread",
                  "t3_get_environment_health",
                ]),
              );
              expect(
                body(await client.callTool({ name: "t3_list_environments", arguments: {} })).data,
              ).toMatchObject({ items: [{ environmentId: "local" }] });
            }
            const notification = Promise.withResolvers<unknown>();
            const unrelated: unknown[] = [];
            clients[0]!.fallbackNotificationHandler = async (value) => {
              notification.resolve(value.params);
            };
            clients[1]!.fallbackNotificationHandler = async (value) => {
              unrelated.push(value);
            };
            const subscription = body(
              await clients[0]!.callTool({
                name: "t3_subscribe_events",
                arguments: { environmentId: "local" },
              }),
            ).data as { subscriptionId: string };
            desktop.socket.send(
              encodeJsonMessage({
                type: "event",
                event: {
                  eventId: "managed-event",
                  environmentId: "local",
                  sequence: 1,
                  type: "thread.started",
                  occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
                  data: {},
                },
              }),
            );
            expect(await notification.promise).toMatchObject({
              subscriptionId: subscription.subscriptionId,
              event: { eventId: "managed-event" },
            });
            await clients[1]!.callTool({ name: "t3_get_gateway_health", arguments: {} });
            expect(unrelated).toEqual([]);
          });
          yield* Fiber.interrupt(relays[1]!);
          yield* Effect.promise(async () => {
            await expect(clients[1]!.listTools()).rejects.toThrow();
            expect(
              body(await clients[0]!.callTool({ name: "t3_get_gateway_health", arguments: {} }))
                .data,
            ).toMatchObject({ bridge: "connected" });
            expect(NodeFS.existsSync(input.stateFile)).toBe(true);
          });
        }),
      ),
    45_000,
  );

  it("discovers tools through the desktop's OpenCode launch configuration without a prestarted owner", async () => {
    const input = await config();
    const entryPoint =
      process.env.T3_MCP_TEST_ENTRYPOINT ??
      NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
    const launch = resolveMcpGatewayLaunchConfig({
      isPackaged: true,
      executablePath: process.env.T3_MCP_TEST_EXECUTABLE ?? process.execPath,
      resourcesPath: NodePath.dirname(entryPoint),
      stateFile: input.stateFile,
    })!;
    // Source runs use bin.ts; packaged runs use the actual desktop bundle unchanged.
    const host = buildMcpGatewayHostConfig(
      {
        ...launch,
        args: [entryPoint],
        env: {
          ...launch.env,
          // A missing explicit state-file regression must never touch the developer's store.
          T3CODE_HOME: NodePath.join(NodePath.dirname(input.stateFile), "fallback"),
        },
      },
      input.token,
      input.port,
    ).opencode.mcp["t3-gateway"];
    // Fail before spawning if the fixture could target the live desktop bridge port.
    expect(host.environment.T3_MCP_BRIDGE_PORT).toBe(String(input.port));
    const client = new Client({ name: "opencode-config-regression", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: host.command[0]!,
      args: host.command.slice(1),
      env: host.environment,
      stderr: "pipe",
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    // Authentication/configuration receipts represent enabling desktop access.
    const desktop = await runtime(input);
    const ownerClosed = new Promise<void>((resolve) =>
      desktop.socket.once("close", () => resolve()),
    );
    cleanup.push(async () => {
      await client.close();
      // Let the owner finish its normal idle shutdown; never find or kill a PID by port.
      await ownerClosed;
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "t3_create_thread",
        "t3_create_agent",
        "t3_get_agents_view",
        "t3_control_thread",
        "t3_get_environment_health",
      ]),
    );
    expect(
      body(await client.callTool({ name: "t3_list_environments", arguments: {} })).data,
    ).toMatchObject({ items: [{ environmentId: "local" }] });
    expect(
      body(await client.callTool({ name: "t3_get_gateway_health", arguments: {} })).data,
    ).toMatchObject({ bridge: "connected" });
    expect(NodeFS.existsSync(input.stateFile)).toBe(true);
  }, 45_000);

  it("elects one bridge owner for five concurrent launchers and keeps all sessions usable", async () => {
    const input = await config();
    const elected: Array<NonNullable<Awaited<ReturnType<typeof owner>>>> = [];
    const launch = async () => {
      const instance = await owner(input);
      if (instance !== undefined) elected.push(instance);
    };
    const clients = await Promise.all(Array.from({ length: 5 }, () => mcp(input, launch)));
    expect(elected).toHaveLength(1);
    const desktop = await runtime(input);
    const results = await Promise.all(
      clients.map((client) => client.callTool({ name: "t3_list_environments", arguments: {} })),
    );
    for (const result of results) {
      expect(body(result).data).toMatchObject({ items: [{ environmentId: "local" }] });
    }
    for (const client of clients) {
      expect(
        body(await client.callTool({ name: "t3_get_gateway_health", arguments: {} })).data,
      ).toMatchObject({ bridge: "connected" });
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(toolNames).toContain("t3_get_agents_view");
      expect(toolNames).toContain("t3_list_agents");
      expect(toolNames).toContain("t3_unsettle_thread");
      expect(toolNames).not.toContain("t3_list_profiles");
    }
    await clients[0]!.close();
    expect(
      body(await clients[4]!.callTool({ name: "t3_list_environments", arguments: {} })).data,
    ).toMatchObject({ items: [{ environmentId: "local" }] });
    await desktop.configure({});
    for (const client of clients.slice(1)) {
      expect(
        body(await client.callTool({ name: "t3_list_environments", arguments: {} })).data,
      ).toMatchObject({ items: [] });
    }
  });

  it("isolates overlapping JSON-RPC ids while sharing mutation receipts and grant revocation", async () => {
    const input = await config();
    await owner(input);
    const clients = await Promise.all(Array.from({ length: 5 }, () => mcp(input)));
    const waiting: Array<{ threadId: unknown; reply: (result: unknown) => void }> = [];
    let isolateReads = true;
    let sends = 0;
    const desktop = await runtime(input, (request, reply) => {
      if (request.method === "getThread") {
        if (isolateReads) {
          waiting.push({ threadId: request.args[1], reply });
          if (waiting.length === 5) {
            for (const pending of waiting.toReversed())
              pending.reply({ id: pending.threadId, messages: [] });
          }
        } else reply({ id: request.args[1], messages: [] });
      } else if (request.method === "getCommandReceipts") reply([]);
      else if (request.method === "hasThreadMessage") reply(false);
      else if (request.method === "sendMessage") {
        sends += 1;
        const send = request.args[0] as { requestId: string; threadId: string; messageId: string };
        reply({
          status: "accepted",
          requestId: send.requestId,
          commandId: send.requestId,
          threadId: send.threadId,
          messageId: send.messageId,
        });
      } else reply([]);
    });
    const results = await Promise.all(
      clients.map((client, index) =>
        client.callTool({
          name: "t3_get_thread",
          arguments: { environmentId: "local", threadId: `thread-${index}` },
        }),
      ),
    );
    results.forEach((result, index) =>
      expect(body(result).data).toMatchObject({ id: `thread-${index}` }),
    );
    isolateReads = false;
    const request = {
      name: "t3_send_message",
      arguments: {
        environmentId: "local",
        threadId: "thread",
        text: "Once",
        idempotencyKey: "same-operation",
      },
    };
    const [first, replay] = await Promise.all([
      clients[0]!.callTool(request),
      clients[1]!.callTool(request),
    ]);
    expect(first.isError).not.toBe(true);
    expect(body(replay).data).toEqual(body(first).data);
    expect(sends).toBe(1);
    await desktop.configure({ local: ["read"] });
    for (const client of clients) {
      const denied = await client.callTool({
        ...request,
        arguments: { ...request.arguments, idempotencyKey: "revoked" },
      });
      expect(denied.isError).toBe(true);
    }
    expect(sends).toBe(1);
  });

  it("rejects token and configuration mismatches without displacing the live runtime", async () => {
    const input = await config();
    await owner(input);
    await runtime(input);
    const original = await mcp(input);
    const launch = vi.fn(async () => undefined);
    await expect(mcp({ ...input, token: "wrong-shared-gateway-token" }, launch)).rejects.toThrow(
      "authentication",
    );
    await expect(mcp({ ...input, stateFile: `${input.stateFile}.other` }, launch)).rejects.toThrow(
      "different configuration",
    );
    expect(launch).not.toHaveBeenCalled();
    expect(
      body(await original.callTool({ name: "t3_get_gateway_health", arguments: {} })).data,
    ).toMatchObject({ bridge: "connected" });
    expect(NodeFS.existsSync(`${input.stateFile}.other`)).toBe(false);
  });

  it("reports an old gateway explicitly instead of starting a degraded MCP session", async () => {
    const input = await config();
    const legacy = createBridgeRuntimePort({ port: input.port, token: input.token });
    cleanup.push(legacy.close);
    await legacy.ready;
    const launch = vi.fn(async () => undefined);
    await expect(mcp(input, launch)).rejects.toThrow("older gateway");
    expect(launch).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(input.stateFile)).toBe(false);
  });

  it("distinguishes a gateway protocol mismatch from configuration and authentication failures", async () => {
    const input = await config();
    const server = new WebSocketServer({ host: "127.0.0.1", port: input.port });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "challenge",
          protocol: "t3-mcp-shared-v0",
          nonce: "mismatched-nonce",
          configuration: sharedGatewayConfiguration(input),
        }),
      );
    });
    const failure = await connectMcpSession({
      port: input.port,
      token: input.token,
      configuration: sharedGatewayConfiguration(input),
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain("Gateway protocol mismatch");
    expect(failure?.message).not.toContain("authentication failed");
  });

  it("forwards stdio from five real child processes without exiting when the first session closes", async () => {
    const input = await config();
    const entryPoint =
      process.env.T3_MCP_TEST_ENTRYPOINT ??
      NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
    const child = await launchSharedOwner(entryPoint, input);
    cleanup.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        if (!child.kill()) resolve();
      });
    });
    await runtime(input);
    const clients = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const client = new Client({ name: "stdio-integration", version: "1.0.0" });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [entryPoint],
          stderr: "pipe",
          env: {
            T3_MCP_BRIDGE_PORT: String(input.port),
            T3_MCP_BRIDGE_TOKEN: input.token,
            T3_MCP_STATE_FILE: input.stateFile,
            T3_MCP_EVENT_RETENTION: String(input.retentionEvents),
            T3_MCP_REPOSITORY_ALLOWLIST: input.repositoryAllowlist.join(","),
            T3_MCP_GRANTS: "{}",
          },
        });
        cleanup.push(() => client.close());
        await client.connect(transport);
        return client;
      }),
    );
    for (const client of clients) {
      expect(
        body(await client.callTool({ name: "t3_list_environments", arguments: {} })).data,
      ).toMatchObject({ items: [{ environmentId: "local" }] });
    }
    await clients[0]!.close();
    expect(
      body(await clients[4]!.callTool({ name: "t3_get_gateway_health", arguments: {} })).data,
    ).toMatchObject({ bridge: "connected" });
    expect(child.exitCode).toBeNull();
  }, 30_000);

  it("delivers and replays subscriptions across separate MCP sessions", async () => {
    const input = await config();
    await owner(input);
    const desktop = await runtime(input);
    const first = await mcp(input);
    const second = await mcp(input);
    const received = Promise.withResolvers<unknown>();
    const unrelated: unknown[] = [];
    first.fallbackNotificationHandler = async (notification) => {
      received.resolve(notification.params);
    };
    second.fallbackNotificationHandler = async (notification) => {
      unrelated.push(notification.params);
    };
    const subscription = await first.callTool({
      name: "t3_subscribe_events",
      arguments: { environmentId: "local" },
    });
    const { subscriptionId } = body(subscription).data as { subscriptionId: string };
    desktop.socket.send(
      JSON.stringify({
        type: "event",
        event: {
          eventId: "runtime-event-1",
          environmentId: "local",
          sequence: 1,
          type: "thread.started",
          occurredAt: DateTime.formatIso(DateTime.nowUnsafe()),
          data: {},
        },
      }),
    );
    expect(await received.promise).toMatchObject({
      subscriptionId,
      event: { eventId: "runtime-event-1" },
    });
    // A completed request provides a transport barrier for checking the other session.
    await second.callTool({ name: "t3_get_gateway_health", arguments: {} });
    expect(unrelated).toEqual([]);
    await first.close();
    const replayed = Promise.withResolvers<unknown>();
    second.fallbackNotificationHandler = async (notification) => {
      replayed.resolve(notification.params);
    };
    const replay = await second.callTool({
      name: "t3_replay_events",
      arguments: { environmentId: "local", subscriptionId },
    });
    expect(replay.isError).not.toBe(true);
    expect(await replayed.promise).toMatchObject({
      subscriptionId,
      event: { eventId: "runtime-event-1" },
    });
  });

  it("disconnects sessions on owner shutdown and recovers receipts through the next owner", async () => {
    const input = await config();
    const firstOwner = await owner(input);
    let sends = 0;
    const respond = (request: RuntimeRequest, reply: (value: unknown) => void) => {
      if (request.method === "getThread") reply({ id: request.args[1], messages: [] });
      else if (request.method === "getCommandReceipts") reply([]);
      else if (request.method === "hasThreadMessage") reply(false);
      else if (request.method === "sendMessage") {
        sends += 1;
        const send = request.args[0] as { requestId: string; threadId: string; messageId: string };
        reply({
          status: "accepted",
          requestId: send.requestId,
          commandId: send.requestId,
          threadId: send.threadId,
          messageId: send.messageId,
        });
      }
    };
    await runtime(input, respond);
    const first = await mcp(input);
    const request = {
      name: "t3_send_message",
      arguments: {
        environmentId: "local",
        threadId: "thread",
        text: "Preserve receipt",
        idempotencyKey: "owner-restart",
      },
    };
    const accepted = await first.callTool(request);
    expect(accepted.isError).not.toBe(true);
    const disconnected = Promise.withResolvers<void>();
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes an onclose callback rather than a DOM event API.
    first.onclose = disconnected.resolve;
    await firstOwner!.close();
    await disconnected.promise;
    await owner(input);
    await runtime(input, respond);
    const reconnected = await mcp(input);
    const replay = await reconnected.callTool(request);
    expect(body(replay).data).toEqual(body(accepted).data);
    expect(sends).toBe(1);
  });

  it("releases an idle owner and permits a fresh owner without changing durable state", async () => {
    const input = await config();
    const idle = Promise.withResolvers<void>();
    const first = await owner(input, { idleTimeoutMs: 20, onIdle: idle.resolve });
    const client = await mcp(input);
    // Closing the final MCP session schedules idle cleanup independently of the desktop.
    await client.close();
    await idle.promise;
    await first!.close();
    expect(await owner(input)).toBeDefined();
    await runtime(input);
    const transport = await connectMcpSession({
      port: input.port,
      token: input.token,
      configuration: sharedGatewayConfiguration(input),
    });
    await transport.close();
  });

  it("retires an owner from another build so the new build serves the session", async () => {
    const input = await config();
    const retired = Promise.withResolvers<void>();
    await owner({ ...input, build: "old" }, { onRetire: retired.resolve });
    const launch = vi.fn(async () => {
      await owner({ ...input, build: "new" });
    });
    const client = await mcp({ ...input, build: "new" }, launch);
    await retired.promise;
    expect(launch).toHaveBeenCalled();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "t3_set_thread_parent",
    );
  });

  it("keeps using an owner too old to report its build", async () => {
    const input = await config();
    await owner(input);
    const launch = vi.fn(async () => undefined);
    const client = await mcp({ ...input, build: "new" }, launch);
    expect(launch).not.toHaveBeenCalled();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("moves a running stdio session to the next owner and announces the tool change", async () => {
    const input = await config();
    const entryPoint =
      process.env.T3_MCP_TEST_ENTRYPOINT ??
      NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url));
    const build = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(entryPoint))
      .digest("hex");
    const first = await owner({ ...input, build });
    const client = new Client({ name: "owner-handover", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      stderr: "pipe",
      env: {
        T3_MCP_BRIDGE_PORT: String(input.port),
        T3_MCP_BRIDGE_TOKEN: input.token,
        T3_MCP_STATE_FILE: input.stateFile,
        T3_MCP_EVENT_RETENTION: String(input.retentionEvents),
        T3_MCP_REPOSITORY_ALLOWLIST: input.repositoryAllowlist.join(","),
        T3_MCP_GRANTS: "{}",
      },
    });
    cleanup.push(async () => {
      await client.close();
      // The session launched a detached owner; a session from another build
      // retires it at once, so nothing is found or killed by PID.
      await connectMcpSession({
        port: input.port,
        token: input.token,
        configuration: sharedGatewayConfiguration(input),
        build: "cleanup",
      }).catch(() => undefined);
    });
    await client.connect(transport);
    const changed = Promise.withResolvers<void>();
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed.resolve());
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    await first!.close();
    await changed.promise;
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "t3_set_thread_parent",
    );
  }, 30_000);
});

it("shares lifecycle grant updates and chat focus across already-connected MCP sessions", async () => {
  const input = await config();
  const clients = await Promise.all([mcp(input), mcp(input)]);
  let controls = 0;
  let opens = 0;
  const desktop = await runtime(input, (request, reply) => {
    if (request.method === "controlThread") {
      controls++;
      const command = request.args[0] as { requestId: string; threadId: string };
      reply({ requestId: command.requestId, threadId: command.threadId, status: "accepted" });
    } else if (request.method === "openThread") {
      opens++;
      reply({ environmentId: request.args[0], threadId: request.args[1], status: "succeeded" });
    } else reply([]);
  });
  const stop = (key: string) => ({
    name: "t3_stop_thread",
    arguments: { environmentId: "local", threadId: "chat", idempotencyKey: key },
  });
  for (const client of clients) {
    expect(body(await client.callTool(stop("denied"))).error?.code).toBe("scope_required");
  }
  expect(controls).toBe(0);
  await desktop.configure({ local: ["read", "control", "lifecycle"] });
  for (const [index, client] of clients.entries()) {
    const stopped = await client.callTool(stop(`allowed-${index}`));
    expect(stopped.isError).not.toBe(true);
    expect(body(stopped).data).toMatchObject({ status: "accepted", threadId: "chat" });
    const opened = await client.callTool({
      name: "t3_open_thread",
      arguments: { environmentId: "local", threadId: "chat" },
    });
    expect(body(opened).data).toMatchObject({ status: "succeeded", threadId: "chat" });
  }
  expect(controls).toBe(2);
  expect(opens).toBe(2);
  await desktop.configure({ local: ["read"] });
  for (const client of clients) {
    expect(body(await client.callTool(stop("revoked"))).error?.code).toBe("scope_required");
  }
  expect(controls).toBe(2);
});
