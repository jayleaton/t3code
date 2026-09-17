import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, RunId, type McpGatewayProfile } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { v2ThreadShell } from "./agents.testFixtures";
import * as DateTime from "effect/DateTime";
import {
  agentThreadStatus,
  groupAgentThreads,
  isAgentChatInFocus,
  selectAgentWorkspaceThreads,
  resolveAgentTaskProject,
} from "./agents.logic";
const profile: McpGatewayProfile = {
  profileId: "write",
  name: "Write",
  revision: 2,
  providerLabel: "Codex",
  modelLabel: "GPT",
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const thread = (id: string, profileId: string | null, settledAt: string | null = null) =>
  presentThreadShell(EnvironmentId.make("local"), {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    modelSelection: { ...v2ThreadShell.modelSelection, model: "old-gpt" },
    settledAt: settledAt === null ? null : DateTime.makeUnsafe(settledAt),
    ...(profileId
      ? {
          profileSnapshot: {
            profileId,
            profileName: "Write",
            revision: 1,
            effectiveSource: {
              modelSelection: "profile",
              runtimeMode: "profile",
              interactionMode: "profile",
              reasoningEffort: "profile",
            },
          },
        }
      : {}),
  });
describe("agent thread grouping", () => {
  it("keeps old revisions grouped, retains removed agents, and recedes settled work", () => {
    const old = thread("old-model", "write");
    const done = thread("done", "write", "2026-09-06T01:00:00.000Z");
    const orphan = thread("orphan", "removed");
    const result = groupAgentThreads([profile], [done, old, orphan, thread("regular", null)]);
    expect(result.groups.get("write")?.map((item) => item.id)).toEqual(["old-model", "done"]);
    expect(result.orphaned).toEqual([orphan]);
    expect(old.modelSelection.model).toBe("old-gpt");
    expect(agentThreadStatus(done)).toBe("done");
    expect(agentThreadStatus(old)).toBe("idle");
    expect(groupAgentThreads([], [old]).orphaned).toEqual([old]);
  });
});

describe("agent chat focus", () => {
  const completed = () => ({
    ...thread("complete", "write"),
    latestRun: {
      runId: RunId.make("run"),
      status: "completed" as const,
      requestedAt: "2026-09-06T00:00:00.000Z",
      startedAt: "2026-09-06T00:00:00.000Z",
      completedAt: "2026-09-06T00:02:00.000Z",
      assistantMessageId: null,
    },
  });
  it("keeps a never-opened completion until it is viewed, and keeps the selected chat", () => {
    const done = completed();
    expect(agentThreadStatus(done)).toBe("done");
    expect(isAgentChatInFocus(done, undefined, false)).toBe(true);
    expect(isAgentChatInFocus(done, "2026-09-06T00:01:00.000Z", false)).toBe(true);
    expect(isAgentChatInFocus(done, "2026-09-06T00:03:00.000Z", false)).toBe(false);
    expect(isAgentChatInFocus(done, "2026-09-06T00:03:00.000Z", true)).toBe(true);
  });
  it("shows idle and running chats but respects explicit settlement", () => {
    expect(isAgentChatInFocus(thread("idle", "write"), undefined, false)).toBe(true);
    const running = {
      ...completed(),
      latestRun: { ...completed().latestRun, status: "running" as const, completedAt: null },
    };
    expect(agentThreadStatus(running)).toBe("running");
    expect(isAgentChatInFocus(running, "2026-09-06T00:03:00.000Z", false)).toBe(true);
    const settled = { ...completed(), settledAt: "2026-09-06T00:03:00.000Z" };
    expect(isAgentChatInFocus(settled, undefined, false)).toBe(false);
    expect(isAgentChatInFocus(settled, undefined, true)).toBe(true);
  });
});

describe("agent workspace selection", () => {
  it("includes completed unsettled work across environments, filters by agent, and clears back to All", () => {
    const done = {
      ...thread("completed task", "write"),
      latestTurn: {
        turnId: "turn" as NonNullable<ReturnType<typeof thread>["latestTurn"]>["turnId"],
        state: "completed" as const,
        requestedAt: "2026-09-06T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-09-06T00:02:00.000Z",
        assistantMessageId: null,
      },
    };
    const remote = {
      ...thread("remote task", "review"),
      environmentId: EnvironmentId.make("remote"),
    };
    const settled = thread("settled task", "write", "2026-09-06T01:00:00.000Z");
    const items = [done, remote, settled, thread("ordinary task", null)];
    expect(selectAgentWorkspaceThreads(items, null, "")).toEqual({
      active: [done, remote],
      settled: [settled],
    });
    expect(selectAgentWorkspaceThreads(items, "write", "")).toEqual({
      active: [done],
      settled: [settled],
    });
    expect(selectAgentWorkspaceThreads(items, null, "").active).toEqual([done, remote]);
    expect(selectAgentWorkspaceThreads(items, null, " REMOTE ").active).toEqual([remote]);
    expect(selectAgentWorkspaceThreads(items, "write", "remote").active).toEqual([]);
    expect(selectAgentWorkspaceThreads(items, null, "ordinary").active).toEqual([items[3]]);
    expect(selectAgentWorkspaceThreads([], null, "")).toEqual({ active: [], settled: [] });
  });
});

describe("agent task project selection", () => {
  const projects = [
    { environmentId: "mac", id: "buildthings", workspaceRoot: "/Users/jay/buildthings" },
    { environmentId: "windows", id: "t3code", workspaceRoot: "C:\\projects\\t3code" },
    { environmentId: "mac", id: "t3code", workspaceRoot: "/Users/jay/t3code" },
  ];
  it("binds a selected project to its machine even when another machine has the same project id", () => {
    expect(resolveAgentTaskProject(projects, "mac", "t3code")).toBe(projects[2]);
    expect(resolveAgentTaskProject(projects.toReversed(), "mac", "t3code")).toBe(projects[2]);
  });
  it("does not substitute a recent project for an empty, removed, or foreign selection", () => {
    expect(resolveAgentTaskProject(projects, "mac", "")).toBeUndefined();
    expect(resolveAgentTaskProject(projects.slice(0, 2), "mac", "t3code")).toBeUndefined();
    expect(resolveAgentTaskProject(projects, "windows", "buildthings")).toBeUndefined();
    expect(resolveAgentTaskProject(projects, "linux", "t3code")).toBeUndefined();
  });
});

describe("agent workspace pull request search", () => {
  it("finds PR references without matching the title and still applies the agent filter", () => {
    const linked = {
      ...thread("Review work", "write"),
      pullRequests: [
        {
          host: "github.com",
          repository: "owner/repository",
          number: 42,
          url: "https://github.com/owner/repository/pull/42",
          source: "manual" as const,
          linkedAt: "2026-09-06T00:00:00Z",
          snapshot: null,
          stack: null,
        },
      ],
    };
    expect(selectAgentWorkspaceThreads([linked], null, "owner/repository").active).toEqual([
      linked,
    ]);
    expect(selectAgentWorkspaceThreads([linked], "other", "owner/repository").active).toEqual([]);
  });
});
