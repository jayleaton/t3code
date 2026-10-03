import { expect, it } from "@effect/vitest";
import type { GatewayRuntimePort } from "@t3tools/client-runtime/gateway";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import { AgentsRemoteRelay, AgentsToolsRegistrationLive } from "./AgentsMcpTools.ts";
import { LocalGatewayPort } from "./LocalGatewayPort.ts";

const localId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("thread-agents-mcp-test");

const makeInvocation = (capabilities: ReadonlyArray<"orchestration" | "preview">) => ({
  environmentId: localId,
  threadId,
  providerSessionId: "provider-session-agents-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const makeLayer = (listedFor: Array<string>, relayed?: Array<unknown>) => {
  const port = {
    listEnvironments: async () => [
      {
        environmentId: localId,
        label: "Local",
        targetKind: "primary",
        connectionState: "connected",
      },
    ],
    listProjects: async (environmentId: string) => {
      listedFor.push(environmentId);
      return { items: [{ id: "project-1", title: "kaizen" }], snapshotAt: "snapshot-1" };
    },
  } as unknown as GatewayRuntimePort;
  const base = AgentsToolsRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.succeed(LocalGatewayPort, { environmentId: localId, label: "Local", port }),
    ),
  );
  if (relayed === undefined) return base;
  return base.pipe(
    Layer.provide(
      Layer.succeed(AgentsRemoteRelay, {
        call: (input) =>
          Effect.sync(() => {
            relayed.push(input);
            return { content: [], structuredContent: { ok: true, relayed: input.tool } };
          }),
      }),
    ),
  );
};

const callTool = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<"orchestration" | "preview"> = ["orchestration"],
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          makeInvocation(capabilities),
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("adds environment tools and leaves router tools to the gateway", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = new Map(server.tools.map(({ tool }) => [tool.name, tool]));
    expect(tools.has("t3_list_projects")).toBe(true);
    expect(tools.has("t3_list_environments")).toBe(false);
    expect(tools.has("t3_subscribe_events")).toBe(false);
    const schema = tools.get("t3_list_projects")!.inputSchema as unknown as {
      properties: Record<string, unknown>;
      required?: Array<string>;
    };
    expect(schema.properties.environmentId).toBeDefined();
    expect(schema.required ?? []).not.toContain("environmentId");
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("runs tools on this environment when no environmentId is given", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {});
    expect(result.isError).toBe(false);
    expect(listedFor).toEqual([localId]);
    expect(result.structuredContent).toMatchObject({ data: { items: [{ title: "kaizen" }] } });
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("refuses chats whose credential lacks orchestration", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", {}, ["preview"]);
    expect(result.isError).toBe(true);
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("explains other environments are unreachable without a relay", () => {
  const listedFor: Array<string> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", { environmentId: "environment-remote" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { message: expect.stringContaining("not reachable from this chat") },
    });
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor)));
});

it.effect("relays other environments' calls with the calling thread", () => {
  const listedFor: Array<string> = [];
  const relayed: Array<unknown> = [];
  return Effect.gen(function* () {
    const result = yield* callTool("t3_list_projects", { environmentId: "environment-remote" });
    expect(result.isError).toBe(false);
    expect(relayed).toEqual([
      {
        environmentId: "environment-remote",
        tool: "t3_list_projects",
        args: { environmentId: "environment-remote" },
        caller: { environmentId: localId, threadId },
      },
    ]);
    expect(listedFor).toEqual([]);
  }).pipe(Effect.provide(makeLayer(listedFor, relayed)));
});
