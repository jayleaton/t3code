import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, RunId, type McpGatewayProfile } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { v2ThreadShell } from "./agents.testFixtures";
import * as DateTime from "effect/DateTime";
import {
  planAgentThreadMove,
  agentThreadStatus,
  groupAgentThreads,
  isAgentChatInFocus,
  selectAgentWorkspaceThreads,
  selectPinnedAgentThreads,
  excludePinnedAgentThreads,
  resolveAgentTaskProject,
  nestAgentRuns,
  agentRunLinkTargets,
  agentRunParentKey,
  agentRunDropZone,
  agentRunReorderOver,
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
    title: id,
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
    // A question or approval is asked mid-turn, while the turn is still running.
    expect(agentThreadStatus({ ...running, hasPendingUserInput: true })).toBe("attention");
    expect(agentThreadStatus({ ...running, hasPendingApprovals: true })).toBe("attention");
    const settled = { ...completed(), settledAt: "2026-09-06T00:03:00.000Z" };
    expect(isAgentChatInFocus(settled, undefined, false)).toBe(false);
    expect(isAgentChatInFocus(settled, undefined, true)).toBe(true);
  });
  it("keeps a chat with background work live after its turn completes", () => {
    const watching = {
      ...completed(),
      pendingBackgroundTasks: [
        { taskId: "watch", description: "Watch CI", kind: "monitor" as const },
      ],
    };
    expect(agentThreadStatus(watching)).toBe("monitoring");
    expect(isAgentChatInFocus(watching, "2026-09-06T00:03:00.000Z", false)).toBe(true);
    const delegating = {
      ...completed(),
      pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" as const }],
    };
    expect(agentThreadStatus(delegating)).toBe("running");
  });
});

describe("agent workspace selection", () => {
  it("includes completed unsettled work across environments, filters by agent, and clears back to All", () => {
    const done = {
      ...thread("completed task", "write"),
      latestRun: {
        runId: RunId.make("done"),
        status: "completed" as const,
        requestedAt: "2026-09-06T00:00:00Z",
        startedAt: null,
        completedAt: "2026-09-06T00:02:00Z",
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

describe("pinned agent chats", () => {
  it("lists unsettled pins newest-first and removes them from the filtered list", () => {
    const pinned = { ...thread("pinned", "write"), pinnedAt: "2026-09-06T02:00:00.000Z" };
    const olderPin = {
      ...thread("older-pin", "review"),
      environmentId: EnvironmentId.make("remote"),
      pinnedAt: "2026-09-06T01:00:00.000Z",
    };
    const unpinned = thread("unpinned", "write");
    const settledPin = {
      ...thread("settled-pin", "write", "2026-09-06T03:00:00.000Z"),
      pinnedAt: "2026-09-06T03:00:00.000Z",
    };
    const all = [unpinned, olderPin, settledPin, pinned];
    const selected = selectPinnedAgentThreads(all);
    expect(selected.map((item) => item.id)).toEqual(["pinned", "older-pin"]);
    expect(excludePinnedAgentThreads(all, selected).map((item) => item.id)).toEqual([
      "unpinned",
      "settled-pin",
    ]);
    expect(excludePinnedAgentThreads([unpinned], [])).toEqual([unpinned]);
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

describe("agent active card order", () => {
  const older = { ...thread("older", "write"), createdAt: "2026-09-01T00:00:00.000Z" };
  const newer = thread("newer", "write");
  const active = (items: readonly (typeof older)[]) =>
    selectAgentWorkspaceThreads(items, null, "").active;

  it("keeps creation order when messages, status, or update times change", () => {
    expect(active([older, newer]).map((item) => item.id)).toEqual(["newer", "older"]);
    expect(
      active([
        {
          ...older,
          updatedAt: "2026-09-20T00:00:00.000Z",
          latestUserMessageAt: "2026-09-20T00:00:00.000Z",
          hasPendingApprovals: true,
        },
        newer,
      ]).map((item) => item.id),
    ).toEqual(["newer", "older"]);
  });

  it("persists moves in both directions and leaves new chats at the top", () => {
    const items = [older, newer];
    const apply = (input: typeof items, moved: typeof older, direction: "up" | "down") => {
      const plan = planAgentThreadMove(active(input), input, moved, direction)!;
      return input.map((item) => ({
        ...item,
        activeOrderKey:
          plan.find((assignment) => assignment.thread.id === item.id)?.orderKey ??
          item.activeOrderKey,
      }));
    };
    const moved = apply(items, older, "up");
    expect(active(JSON.parse(JSON.stringify(moved))).map((item) => item.id)).toEqual([
      "older",
      "newer",
    ]);
    expect(active([...moved, thread("new-chat", "write")]).map((item) => item.id)).toEqual([
      "new-chat",
      "older",
      "newer",
    ]);
    expect(active(apply(moved, older, "down")).map((item) => item.id)).toEqual(["newer", "older"]);
    expect(planAgentThreadMove(active(items), items, newer, "up")).toBeNull();
    expect(planAgentThreadMove(active(items), items, older, "down")).toBeNull();
  });

  it("excludes pinned and settled cards and scopes duplicate IDs to their machines", () => {
    const remote = { ...older, environmentId: EnvironmentId.make("remote") };
    const pinned = { ...thread("pinned", "write"), pinnedAt: "2026-09-06T00:00:00.000Z" };
    const settled = thread("settled", "write", "2026-09-06T00:00:00.000Z");
    const items = [older, remote, pinned, settled];
    const plan = planAgentThreadMove(items, items, remote, "up")!;
    const arranged = items.map((item) => ({
      ...item,
      activeOrderKey:
        plan.find(
          (assignment) =>
            assignment.thread.id === item.id &&
            assignment.thread.environmentId === item.environmentId,
        )?.orderKey ?? null,
    }));
    expect(plan.every(({ thread }) => thread.pinnedAt == null && thread.settledAt === null)).toBe(
      true,
    );
    expect(
      active(arranged)
        .filter((item) => item.pinnedAt == null)
        .map((item) => item.environmentId),
    ).toEqual(["remote", "local"]);
    expect(planAgentThreadMove(items, items, pinned, "down")).toBeNull();
  });
});

describe("nestAgentRuns", () => {
  const run = (
    id: string,
    parentThreadId: string | null,
    options: { settled?: boolean; pinned?: boolean; minute?: number; orderKey?: string } = {},
  ) => ({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(id),
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    lineage: {
      rootThreadId: ThreadId.make(parentThreadId ?? id),
      parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
      relationshipToParent: parentThreadId === null ? null : ("subagent" as const),
    },
    createdAt: `2026-09-25T00:${String(options.minute ?? 0).padStart(2, "0")}:00.000Z`,
    settledAt: options.settled ? "2026-09-25T01:00:00.000Z" : null,
    pinnedAt: options.pinned ? "2026-09-25T01:00:00.000Z" : null,
    archivedAt: null,
    activeOrderKey: options.orderKey ?? null,
    unsettledAt: null,
  });
  const ids = (runs: readonly { id: string }[]) => runs.map((item) => item.id);
  const entries = (runs: readonly { thread: { id: string }; depth: number }[] | undefined) =>
    runs?.map((child) => [child.thread.id, child.depth]);
  const coordinator = run("coordinator", null);
  const tests = run("tests", "coordinator", { minute: 1 });
  const docs = run("docs", "coordinator", { minute: 2, settled: true });
  const deps = run("deps", "tests", { minute: 3 });

  it("folds sub-runs, including settled and filtered-out ones, into the parent's card", () => {
    const nested = nestAgentRuns({
      lists: { pinned: [], active: [coordinator, tests], settled: [docs] },
      all: [coordinator, tests, docs, deps],
    });
    expect(ids(nested.lists.active)).toEqual(["coordinator"]);
    expect(nested.lists.settled).toEqual([]);
    const children = nested.childrenByKey.get("local:coordinator");
    expect(entries(children?.live)).toEqual([
      ["tests", 0],
      ["deps", 1],
    ]);
    expect(entries(children?.settled)).toEqual([["docs", 0]]);
  });

  it("orders sub-runs like the board: pinned on top, then arranged, then settled last", () => {
    const pinned = run("pinned", "coordinator", { pinned: true, minute: 5 });
    const first = run("first", "coordinator", { minute: 6, orderKey: "a" });
    const second = run("second", "coordinator", { minute: 7, orderKey: "b" });
    const nested = nestAgentRuns({
      lists: { pinned: [pinned], active: [coordinator, second, first], settled: [docs] },
      all: [coordinator, pinned, first, second, docs],
    });
    expect(nested.lists.pinned).toEqual([]);
    const children = nested.childrenByKey.get("local:coordinator");
    expect(entries(children?.live)).toEqual([
      ["pinned", 0],
      ["first", 0],
      ["second", 0],
    ]);
    expect(ids(children!.live[1]!.siblings)).toEqual(["pinned", "first", "second", "docs"]);
    expect(entries(children?.settled)).toEqual([["docs", 0]]);
  });

  it("keeps live sub-runs of a settled run on their own cards", () => {
    const settledCoordinator = run("coordinator", null, { settled: true });
    const nested = nestAgentRuns({
      lists: { pinned: [], active: [tests], settled: [settledCoordinator, docs] },
      all: [settledCoordinator, tests, docs],
    });
    expect(ids(nested.lists.active)).toEqual(["tests"]);
    expect(ids(nested.lists.settled)).toEqual(["coordinator"]);
    expect(entries(nested.childrenByKey.get("local:coordinator")?.settled)).toEqual([["docs", 0]]);
  });

  it("leaves a sub-run whose parent is not on the board as its own card", () => {
    const nested = nestAgentRuns({
      lists: { pinned: [], active: [tests], settled: [] },
      all: [tests],
    });
    expect(ids(nested.lists.active)).toEqual(["tests"]);
    expect(nested.childrenByKey.size).toBe(0);
  });
});

describe("sidebar delegated relationships", () => {
  const captain = thread("captain-chat", "captain");
  const cody = thread("cody-chat", "cody");
  const delegated = {
    ...thread("cody-delegation", "cody"),
    parentThreadId: captain.id,
    lineage: {
      rootThreadId: captain.id,
      parentThreadId: captain.id,
      relationshipToParent: "subagent" as const,
    },
  };
  const linkedCody = { ...thread("linked-cody-chat", "cody"), parentThreadId: captain.id };
  const fork = {
    ...thread("cody-fork", "cody"),
    parentThreadId: captain.id,
    lineage: { ...delegated.lineage, relationshipToParent: "fork" as const },
  };
  const all = [captain, cody, delegated, linkedCody, fork];
  const lists = { pinned: [], active: all, settled: [] };

  it("summarizes delegation to a named Agent while retaining its top-level and linked chats", () => {
    const sidebar = nestAgentRuns({ lists, all, subagentsOnly: true });
    expect(sidebar.lists.active.map((run) => run.id)).toEqual([
      captain.id,
      cody.id,
      linkedCody.id,
      fork.id,
    ]);
    expect(
      sidebar.childrenByKey.get("local:captain-chat")?.live.map(({ thread }) => thread.id),
    ).toEqual([delegated.id]);
    // Profile grouping is independent of sidebar delegation folding.
    expect(
      groupAgentThreads([{ ...profile, profileId: "cody", name: "Cody" }], all).groups.get("cody"),
    ).toHaveLength(4);
    const workspace = nestAgentRuns({ lists, all });
    expect(
      workspace.childrenByKey
        .get("local:captain-chat")
        ?.live.map(({ thread }) => thread.id)
        .toSorted(),
    ).toEqual([delegated.id, linkedCody.id, fork.id].toSorted());
    expect(workspace.lists.active.map((run) => run.id)).toEqual([captain.id, cody.id]);
  });

  it("uses native lineage even when a manual parent link differs, and requires a parent ID", () => {
    const moved = { ...delegated, parentThreadId: cody.id };
    const noParent = {
      ...delegated,
      id: ThreadId.make("no-parent"),
      lineage: { ...delegated.lineage, parentThreadId: null },
    };
    const sidebar = nestAgentRuns({
      lists: { ...lists, active: [captain, cody, moved, noParent] },
      all: [captain, cody, moved, noParent],
      subagentsOnly: true,
    });
    expect(
      sidebar.childrenByKey.get("local:captain-chat")?.live.map(({ thread }) => thread.id),
    ).toEqual([moved.id]);
    expect(sidebar.lists.active.map((run) => run.id)).toEqual([captain.id, cody.id, noParent.id]);
  });

  it("keeps delegated rows out of the sidebar when the parent is filtered out", () => {
    const sidebar = nestAgentRuns({
      lists: { ...lists, active: [cody, delegated] },
      all,
      subagentsOnly: true,
    });
    expect(sidebar.lists.active).toEqual([cody]);
    const workspace = nestAgentRuns({ lists: { ...lists, active: [cody, delegated] }, all });
    expect(workspace.lists.active).toEqual([cody, delegated]);
  });
});

describe("agentRunLinkTargets", () => {
  const run = (
    id: string,
    parentThreadId: string | null,
    environmentId = "local",
    parentEnvironmentId?: string,
  ) => ({
    environmentId: EnvironmentId.make(environmentId),
    id: ThreadId.make(id),
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    ...(parentEnvironmentId === undefined
      ? {}
      : { parentEnvironmentId: EnvironmentId.make(parentEnvironmentId) }),
  });
  const root = run("root", null);
  const child = run("child", "root");
  // A sub-run on another machine, nested under a local chat.
  const remoteChild = run("remote-child", "child", "remote", "local");
  const loose = run("loose", null);
  const remote = run("remote", null, "remote");
  const all = [root, child, remoteChild, loose, remote];

  it("offers every run on any environment outside the dragged run's own tree", () => {
    expect([...agentRunLinkTargets(loose, all)].toSorted()).toEqual([
      "local:child",
      "local:root",
      "remote:remote",
      "remote:remote-child",
    ]);
    expect([...agentRunLinkTargets(remote, all)].toSorted()).toEqual([
      "local:child",
      "local:loose",
      "local:root",
      "remote:remote-child",
    ]);
  });

  it("rejects cycles that cross environments, and the current parent", () => {
    // root cannot move under its own sub-runs, including the one on the other machine.
    expect([...agentRunLinkTargets(root, all)].toSorted()).toEqual([
      "local:loose",
      "remote:remote",
    ]);
    // remote-child is already under child.
    expect([...agentRunLinkTargets(remoteChild, all)].toSorted()).toEqual([
      "local:loose",
      "local:root",
      "remote:remote",
    ]);
  });

  it("resolves parents on another environment by both IDs", () => {
    expect(agentRunParentKey(remoteChild)).toBe("local:child");
    expect(agentRunParentKey(child)).toBe("local:root");
    expect(agentRunParentKey(root)).toBeNull();
  });
});

describe("agentRunDropZone", () => {
  const card = { top: 100, bottom: 300 };
  const both = { nest: true, reorder: true };

  it("links in the middle of the card and reorders at its edges", () => {
    expect(agentRunDropZone(140, card, both)).toBe("before");
    expect(agentRunDropZone(160, card, both)).toBe("nest");
    expect(agentRunDropZone(240, card, both)).toBe("nest");
    expect(agentRunDropZone(260, card, both)).toBe("after");
    expect(agentRunDropZone(310, card, both)).toBeNull();
  });

  it("reorders by halves over a card the run cannot link under", () => {
    const reorderOnly = { nest: false, reorder: true };
    expect(agentRunDropZone(190, card, reorderOnly)).toBe("before");
    expect(agentRunDropZone(210, card, reorderOnly)).toBe("after");
  });

  it("links anywhere on the card for drags that cannot reorder", () => {
    expect(agentRunDropZone(101, card, { nest: true, reorder: false })).toBe("nest");
    expect(agentRunDropZone(150, card, { nest: false, reorder: false })).toBeNull();
  });
});

describe("agentRunReorderOver", () => {
  const ids = ["a", "b", "c"];

  it("moves down past a card only from its bottom edge", () => {
    expect(agentRunReorderOver(ids, "a", "b", "before")).toBe("a");
    expect(agentRunReorderOver(ids, "a", "b", "after")).toBe("b");
    expect(agentRunReorderOver(ids, "a", "c", "after")).toBe("c");
  });

  it("moves up past a card only from its top edge", () => {
    expect(agentRunReorderOver(ids, "c", "b", "after")).toBe("c");
    expect(agentRunReorderOver(ids, "c", "b", "before")).toBe("b");
    expect(agentRunReorderOver(ids, "c", "a", "after")).toBe("b");
  });

  it("ignores cards outside the list", () => {
    expect(agentRunReorderOver(ids, "a", "pinned", "before")).toBeNull();
  });
});
