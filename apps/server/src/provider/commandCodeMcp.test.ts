// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, expect, it, vi } from "vite-plus/test";
import { COMMAND_CODE_MCP_MOD } from "./commandCodeMcp.ts";

type Tool = {
  schema: { name: string; description: string; input_schema: unknown };
  readOnly: boolean;
  run: (context: { input: unknown; signal?: AbortSignal }) => Promise<unknown>;
};
const loadMod = () =>
  import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(COMMAND_CODE_MCP_MOD).toString("base64")}`
  ) as Promise<{
    default: (cmd: {
      addTool: (tool: Tool) => void;
      on: (name: string, handler: () => Promise<void>) => void;
    }) => Promise<void>;
  }>;
const originalServers = process.env.T3_COMMANDCODE_MCP_SERVERS;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalServers === undefined) delete process.env.T3_COMMANDCODE_MCP_SERVERS;
  else process.env.T3_COMMANDCODE_MCP_SERVERS = originalServers;
});

it("registers both T3 endpoints with pagination, scoped authorization, errors and image results", async () => {
  process.env.T3_COMMANDCODE_MCP_SERVERS = JSON.stringify([
    { name: "t3-code", url: "http://localhost/mcp", authorizationHeader: "Bearer thread-one" },
    {
      name: "t3-gateway",
      url: "http://localhost/gateway",
      authorizationHeader: "Bearer thread-one",
    },
  ]);
  const writes = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer thread-one");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, method: init?.method ?? "GET", body });
    if (body.method !== "initialize") expect(headers.get("mcp-session-id")).toBe(url);
    if (init?.method === "DELETE" || body.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {} };
    else if (body.method === "tools/list")
      result = body.params.cursor
        ? { tools: [{ name: "edit", inputSchema: { type: "object" } }] }
        : {
            tools: [
              {
                name: "read",
                description: "Read state",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
            nextCursor: "next",
          };
    else
      result = body.params.arguments.fail
        ? { isError: true, content: [{ type: "text", text: "Denied by T3" }] }
        : {
            content: [
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
              { type: "resource", resource: { uri: "file:///test", text: "details" } },
            ],
          };
    return Response.json(
      { jsonrpc: "2.0", id: body.id, result },
      { headers: { "mcp-session-id": url } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const tools: Tool[] = [];
  let shutdown = async () => {};
  await (
    await loadMod()
  ).default({
    addTool: (tool) => tools.push(tool),
    on: (name, handler) => {
      expect(name).toBe("session_shutdown");
      shutdown = handler;
    },
  });
  expect(tools.map((tool) => tool.schema.name)).toEqual([
    "mcp__t3_code__read",
    "mcp__t3_code__edit",
    "mcp__t3_gateway__read",
    "mcp__t3_gateway__edit",
  ]);
  expect(tools.map((tool) => tool.readOnly)).toEqual([true, false, true, false]);
  expect(tools[1]!.schema.input_schema).toEqual({ type: "object", properties: {}, required: [] });
  expect(await tools[0]!.run({ input: {} })).toEqual({
    ok: true,
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "text", text: "details" },
    ],
  });
  expect(await tools[3]!.run({ input: { fail: true } })).toEqual({
    ok: false,
    error: "Denied by T3",
  });
  expect(calls.at(-1)?.body).toMatchObject({
    method: "tools/call",
    params: { name: "edit", arguments: { fail: true } },
  });
  expect(String(writes.mock.calls.at(-1)?.[0])).toContain("t3_mcp_ready");
  await shutdown();
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  expect(COMMAND_CODE_MCP_MOD).not.toContain("thread-one");
});

it("reads chunked SSE responses and cancels tool calls when the turn is interrupted", async () => {
  process.env.T3_COMMANDCODE_MCP_SERVERS = JSON.stringify([
    { name: "t3-code", url: "http://localhost/mcp", authorizationHeader: "Bearer scoped" },
  ]);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        init?.signal?.throwIfAborted();
        throw new Error("Expected aborted call");
      }
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2025-06-18" }
          : { tools: [{ name: "wait", inputSchema: { type: "object" } }] };
      const message = `data: {"method":"notifications/progress"}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\r\n\r\n`;
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const part of [message.slice(0, 19), message.slice(19)])
              controller.enqueue(new TextEncoder().encode(part));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const tools: Tool[] = [];
  await (await loadMod()).default({ addTool: (tool) => tools.push(tool), on: () => {} });
  expect(tools).toHaveLength(1);
  expect(
    await tools[0]!.run({ input: {}, signal: AbortSignal.abort(new Error("Turn interrupted")) }),
  ).toEqual({ ok: false, error: "Turn interrupted" });
});

it("reports MCP startup failures instead of advertising a successful connection", async () => {
  process.env.T3_COMMANDCODE_MCP_SERVERS = JSON.stringify([
    { name: "t3-code", url: "http://localhost/mcp", authorizationHeader: "Bearer scoped" },
  ]);
  const writes = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
  );
  await expect(
    (await loadMod()).default({
      addTool: () => {
        throw new Error("Unexpected tool");
      },
      on: () => {},
    }),
  ).rejects.toThrow("HTTP 401");
  expect(String(writes.mock.calls.at(-1)?.[0])).toContain("t3_mcp_error");
  expect(String(writes.mock.calls.at(-1)?.[0])).not.toContain("Bearer scoped");
});
