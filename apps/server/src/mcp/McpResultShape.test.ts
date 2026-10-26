import { describe, expect, it } from "@effect/vitest";
import { McpSchema } from "effect/ai";

import { leanJson, leanToolResult, wantsLeanResults } from "./McpResultShape.ts";

describe("leanJson", () => {
  it("drops null, undefined and empty-array fields at any depth", () => {
    expect(
      leanJson(
        { taskId: "t", needs: null, wake: undefined, evidence: [], sync: { lastError: null } },
        undefined,
      ),
    ).toEqual({ taskId: "t", sync: {} });
  });

  it("keeps false, zero, empty strings, empty objects and array positions", () => {
    expect(
      leanJson({ timedOut: false, cursor: 0, title: "", options: {}, rows: [null, []] }, undefined),
    ).toEqual({ timedOut: false, cursor: 0, title: "", options: {}, rows: [null, []] });
  });

  it("drops values the reader already has", () => {
    expect(
      leanJson(
        {
          taskId: "node-1",
          childNodeId: "node-1",
          tasks: [
            { task: { taskId: "a", ownerThreadId: "caller" } },
            { task: { taskId: "b", ownerThreadId: "other" } },
          ],
          items: [
            { environmentIds: ["mac", "box"], availableEnvironmentIds: ["box", "mac"] },
            { environmentIds: ["mac", "phone"], availableEnvironmentIds: ["mac"] },
          ],
        },
        "caller",
      ),
    ).toEqual({
      taskId: "node-1",
      tasks: [{ task: { taskId: "a" } }, { task: { taskId: "b", ownerThreadId: "other" } }],
      items: [
        { availableEnvironmentIds: ["box", "mac"] },
        { environmentIds: ["mac", "phone"], availableEnvironmentIds: ["mac"] },
      ],
    });
  });

  it("keeps a childNodeId that differs from its taskId", () => {
    expect(leanJson({ taskId: "a", childNodeId: "b" }, undefined)).toEqual({
      taskId: "a",
      childNodeId: "b",
    });
  });
});

describe("leanToolResult", () => {
  it("serves one structured copy and keeps failures whole", () => {
    const ok = new McpSchema.CallToolResult({
      isError: false,
      structuredContent: { runId: null, status: "idle" },
      content: [{ type: "text", text: '{"runId":null,"status":"idle"}' }],
    });
    expect(leanToolResult(ok, undefined)).toMatchObject({
      structuredContent: { status: "idle" },
      content: [],
    });
    const failed = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: { error: { code: "x", details: null } },
      content: [{ type: "text", text: "failed" }],
    });
    expect(leanToolResult(failed, undefined)).toBe(failed);
  });

  it("is chosen only for harnesses whose model reads structuredContent", () => {
    expect(wantsLeanResults({ name: "claude-code", version: "2.1.310" })).toBe(true);
    expect(wantsLeanResults({ name: "codex-mcp-client", version: "0.164.0" })).toBe(true);
    expect(wantsLeanResults({ name: "t3-thread-cli", version: "1" })).toBe(false);
    expect(wantsLeanResults(undefined)).toBe(false);
  });
});
