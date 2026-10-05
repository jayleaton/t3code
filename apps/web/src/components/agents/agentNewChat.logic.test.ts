import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type McpGatewayProfile } from "@t3tools/contracts";
import {
  defaultNewChatMachine,
  defaultNewChatProfile,
  sortProjectsByNewChatRecency,
} from "./agentNewChat.logic";

const agent = (name: string, runtimeMode: McpGatewayProfile["runtimeMode"] = "full-access") =>
  ({ profileId: name.toLowerCase(), name, runtimeMode }) as McpGatewayProfile;

describe("defaultNewChatProfile", () => {
  it("prefers Captain wherever it sits in the board order", () => {
    expect(defaultNewChatProfile([agent("Cody"), agent(" captain ")])?.profileId).toBe(" captain ");
  });
  it("falls back to the first agent that can start chats", () => {
    expect(
      defaultNewChatProfile([
        agent("Captain", "read-only"),
        agent("Reader", "read-only"),
        agent("Cody"),
      ])?.profileId,
    ).toBe("cody");
    expect(defaultNewChatProfile([agent("Reader", "read-only")])).toBeUndefined();
  });
});

describe("defaultNewChatMachine", () => {
  it("keeps the last machine while it can run the agent", () => {
    expect(defaultNewChatMachine(["mac", "windows"], "windows")).toBe("windows");
  });
  it("falls back to the first eligible machine, or none", () => {
    expect(defaultNewChatMachine(["mac", "windows"], "linux")).toBe("mac");
    expect(defaultNewChatMachine(["mac"], null)).toBe("mac");
    expect(defaultNewChatMachine([], "mac")).toBe("");
  });
});

describe("sortProjectsByNewChatRecency", () => {
  const project = (id: string, environmentId = "mac") => ({ environmentId, id, title: id });
  const thread = (
    projectId: string,
    createdAt: string,
    extra: { environmentId?: string; parentRelationship?: "subagent" | "child" } = {},
  ) => ({
    environmentId: EnvironmentId.make(extra.environmentId ?? "mac"),
    projectId: ProjectId.make(projectId),
    createdAt,
    parentThreadId: extra.parentRelationship ? ("parent" as never) : null,
    parentRelationship: extra.parentRelationship ?? null,
    lineage: {} as never,
  });

  it("orders by the latest chat created in each project, then alphabetically", () => {
    const sorted = sortProjectsByNewChatRecency(
      [project("alpha"), project("lockpick"), project("sidebud"), project("t3"), project("zeta")],
      [
        thread("lockpick", "2026-10-01T00:00:00.000Z"),
        thread("t3", "2026-09-01T00:00:00.000Z"),
        thread("t3", "2026-10-05T00:00:00.000Z"),
        thread("sidebud", "2026-10-03T00:00:00.000Z"),
      ],
    );
    expect(sorted.map(({ id }) => id)).toEqual(["t3", "sidebud", "lockpick", "alpha", "zeta"]);
  });
  it("ignores subagents and the same project id on another machine", () => {
    const sorted = sortProjectsByNewChatRecency(
      [project("lockpick"), project("t3")],
      [
        thread("lockpick", "2026-10-01T00:00:00.000Z"),
        thread("t3", "2026-10-04T00:00:00.000Z", { parentRelationship: "subagent" }),
        thread("t3", "2026-10-05T00:00:00.000Z", { environmentId: "windows" }),
      ],
    );
    expect(sorted.map(({ id }) => id)).toEqual(["lockpick", "t3"]);
  });
  it("counts child chats an agent started as new chats", () => {
    const sorted = sortProjectsByNewChatRecency(
      [project("lockpick"), project("t3")],
      [
        thread("lockpick", "2026-10-01T00:00:00.000Z"),
        thread("t3", "2026-10-04T00:00:00.000Z", { parentRelationship: "child" }),
      ],
    );
    expect(sorted.map(({ id }) => id)).toEqual(["t3", "lockpick"]);
  });
});
