import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, RunId, type McpGatewayProfile } from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { v2ThreadShell } from "./agents.testFixtures.ts";
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
  selectAgentSidebarThreads,
  agentRunLinkTargets,
  agentRunParentKey,
  agentRunDropZone,
  agentRunReorderOver,
  applyAgentParentOverrides,
  agentRunLinkBlockedReason,
  withAgentRunAncestors,
  selectWorkingParentKeys,
  agentColorFor,
  agentColors,
  agentIconKey,
} from "./agents.ts";
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

describe("subagents and Agent chats on the board", () => {
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
  const childIds = (board: ReturnType<typeof nestAgentRuns<(typeof all)[number]>>, key: string) =>
    board.childrenByKey
      .get(key)
      ?.live.map(({ thread }) => thread.id)
      .toSorted();

  it("never makes a delegated subagent a card, in any shelf or nested roster", () => {
    const pinnedDelegation = {
      ...delegated,
      id: ThreadId.make("pinned-delegation"),
      pinnedAt: "2026-09-25T01:00:00Z",
    };
    const settledDelegation = {
      ...delegated,
      id: ThreadId.make("settled-delegation"),
      settledAt: "2026-09-25T01:00:00Z",
    };
    const sidebarThreads = selectAgentSidebarThreads([...all, pinnedDelegation, settledDelegation]);
    expect(sidebarThreads.map((run) => run.id)).toEqual([
      captain.id,
      cody.id,
      linkedCody.id,
      fork.id,
    ]);
    const shelves = selectAgentWorkspaceThreads(sidebarThreads, null, "");
    const board = nestAgentRuns({
      lists: { pinned: selectPinnedAgentThreads(sidebarThreads), ...shelves },
      all: sidebarThreads,
    });
    expect(childIds(board, "local:captain-chat")).toEqual([linkedCody.id, fork.id].toSorted());
    // Searching the board cannot surface a subagent either.
    expect(selectAgentWorkspaceThreads(sidebarThreads, null, "delegation").active).toEqual([]);
  });

  it("nests a child Agent chat inside its parent's card instead of its own card", () => {
    const sidebarThreads = selectAgentSidebarThreads(all);
    const lists = { pinned: [], active: sidebarThreads, settled: [] };
    const board = nestAgentRuns({ lists, all: sidebarThreads });
    expect(board.lists.active.map((run) => run.id)).toEqual([captain.id, cody.id]);
    expect(childIds(board, "local:captain-chat")).toEqual([linkedCody.id, fork.id].toSorted());
    // Pinned parent and pinned child, as in the GLM / TensorFold report.
    const pinnedParent = { ...captain, pinnedAt: "2026-10-04T07:00:00Z" };
    const pinnedChild = { ...linkedCody, pinnedAt: "2026-10-04T07:01:00Z" };
    const pinnedBoard = nestAgentRuns({
      lists: { pinned: [pinnedChild, pinnedParent], active: [cody], settled: [] },
      all: [pinnedParent, pinnedChild, cody],
    });
    expect(pinnedBoard.lists.pinned.map((run) => run.id)).toEqual([captain.id]);
    expect(childIds(pinnedBoard, "local:captain-chat")).toEqual([linkedCody.id]);
  });

  it("nests a named-agent delegate as a child; only a recorded subagent stays off the board", () => {
    // Randy reviewing for Captain through delegate_task: a child chat despite its task lineage.
    const randyReview = {
      ...delegated,
      id: ThreadId.make("randy-review"),
      parentRelationship: "child" as const,
    };
    const helper = {
      ...delegated,
      id: ThreadId.make("helper"),
      parentRelationship: "subagent" as const,
    };
    const sidebarThreads = selectAgentSidebarThreads([captain, randyReview, helper]);
    expect(sidebarThreads.map((run) => run.id)).toEqual([captain.id, randyReview.id]);
    const board = nestAgentRuns({
      lists: { pinned: [], active: sidebarThreads, settled: [] },
      all: sidebarThreads,
    });
    expect(board.lists.active.map((run) => run.id)).toEqual([captain.id]);
    expect(childIds(board, "local:captain-chat")).toEqual([randyReview.id]);
  });

  it("shows a just-launched child in its parent's card at once, before any run or profile", () => {
    // t3_thread_launch commits thread.created (with its parent) before the
    // worktree is prepared, so the card must not wait for a run.
    const launching = {
      ...thread("launching", "doug"),
      parentThreadId: captain.id,
      parentRelationship: "child" as const,
      runtime: { ...thread("x", null).runtime, status: "preparing" },
    } as ReturnType<typeof thread>;
    const bare = {
      ...thread("bare", null),
      parentThreadId: captain.id,
      parentRelationship: "child" as const,
    };
    const sidebarThreads = selectAgentSidebarThreads([captain, launching, bare]);
    const board = nestAgentRuns({
      lists: { pinned: [], ...selectAgentWorkspaceThreads(sidebarThreads, null, "") },
      all: sidebarThreads,
    });
    expect(childIds(board, "local:captain-chat")).toEqual([bare.id, launching.id].toSorted());
    expect(agentThreadStatus(launching)).toBe("queued");
    expect(isAgentChatInFocus(launching, undefined, false)).toBe(true);
  });

  it("keeps a child's parent card in the open-chat rail", () => {
    const sidebarThreads = selectAgentSidebarThreads(all);
    expect(withAgentRunAncestors([linkedCody], sidebarThreads).map((run) => run.id)).toEqual([
      linkedCody.id,
      captain.id,
    ]);
    const settledCaptain = { ...captain, settledAt: "2026-10-04T07:00:00Z" };
    expect(withAgentRunAncestors([linkedCody], [settledCaptain, linkedCody])).toEqual([linkedCody]);
  });
});

describe("rolled-up status", () => {
  const withRun = <T extends ReturnType<typeof thread>>(
    chat: T,
    status: "running" | "completed",
  ) => ({
    ...chat,
    latestRun: {
      runId: RunId.make(`${chat.id}-run`),
      status,
      requestedAt: "2026-10-04T05:58:00.000Z",
      startedAt: "2026-10-04T05:58:00.000Z",
      completedAt: status === "completed" ? "2026-10-04T05:59:00.000Z" : null,
      assistantMessageId: null,
    },
  });
  const github = withRun(thread("github-chat", "doug"), "completed");
  const glm = { ...withRun(thread("glm-chat", "doug"), "running"), parentThreadId: github.id };

  it("keeps a parent in progress while a chat under it works, at any depth", () => {
    expect(agentThreadStatus(github)).toBe("done");
    expect(selectWorkingParentKeys([github, glm])).toEqual(new Set(["local:github-chat"]));
    expect(agentThreadStatus(github, true)).toBe("running");
    const glmDone = { ...glm, latestRun: { ...glm.latestRun, status: "completed" as const } };
    const review = { ...withRun(thread("review", "cody"), "running"), parentThreadId: glm.id };
    expect(selectWorkingParentKeys([github, glmDone, review])).toEqual(
      new Set(["local:glm-chat", "local:github-chat"]),
    );
    const monitoring = {
      ...glmDone,
      pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const }],
    };
    expect(agentThreadStatus(monitoring)).toBe("monitoring");
    expect(selectWorkingParentKeys([github, monitoring])).toEqual(new Set(["local:github-chat"]));
    expect(selectWorkingParentKeys([github, glmDone])).toEqual(new Set());
    // Its turn ended but a command it started runs on in the background.
    const glmMonitoring = {
      ...glmDone,
      pendingBackgroundTasks: [
        { taskId: "sleep", description: "sleep 90", kind: "command" as const },
      ],
    };
    expect(agentThreadStatus(glmMonitoring)).toBe("monitoring");
    expect(selectWorkingParentKeys([github, glmMonitoring])).toEqual(
      new Set(["local:github-chat"]),
    );
    expect(
      selectWorkingParentKeys([github, { ...glm, archivedAt: "2026-10-04T06:00:00Z" }]),
    ).toEqual(new Set());
    expect(agentThreadStatus({ ...github, settledAt: "2026-10-04T06:00:00Z" }, true)).toBe("done");
  });

  it("keeps an owner in progress while its own subagent works", () => {
    const helper = {
      ...withRun(thread("helper", "doug"), "running"),
      parentThreadId: github.id,
      parentRelationship: "subagent" as const,
    };
    expect(selectWorkingParentKeys([github, helper])).toEqual(new Set(["local:github-chat"]));
  });
});

describe("parent changes on the board", () => {
  const github = thread("github-chat", "doug");
  const other = thread("other-chat", "doug");
  const glm = { ...thread("glm-chat", "doug") };
  const board = (threads: readonly (typeof glm)[]) =>
    nestAgentRuns({ lists: { pinned: [], active: threads, settled: [] }, all: threads });

  it("shows a pending move at once and rolls back to the server's link", () => {
    const pending = new Map([
      ["local:glm-chat", { parentThreadId: github.id, parentEnvironmentId: null }],
    ]);
    const moved = applyAgentParentOverrides([github, other, glm], pending);
    expect(board(moved).childrenByKey.get("local:github-chat")?.live[0]?.thread.id).toBe(glm.id);
    // Rolling back is dropping the entry: the server's state is all that is left.
    const rolledBack = applyAgentParentOverrides([github, other, glm], new Map());
    expect(board(rolledBack).lists.active.map((run) => run.id)).toEqual([
      github.id,
      other.id,
      glm.id,
    ]);
    // Re-parenting and removing work the same way.
    const nested = { ...glm, parentThreadId: github.id };
    const reparented = applyAgentParentOverrides(
      [github, other, nested],
      new Map([["local:glm-chat", { parentThreadId: other.id, parentEnvironmentId: null }]]),
    );
    expect(board(reparented).childrenByKey.get("local:other-chat")?.live[0]?.thread.id).toBe(
      glm.id,
    );
    const removed = applyAgentParentOverrides(
      [github, other, nested],
      new Map([["local:glm-chat", { parentThreadId: null, parentEnvironmentId: null }]]),
    );
    expect(board(removed).childrenByKey.size).toBe(0);
  });

  it("explains why a card cannot take the run", () => {
    const nested = { ...glm, parentThreadId: github.id };
    expect(agentRunLinkBlockedReason(nested, github)).toBe("Already under github-chat");
    expect(agentRunLinkBlockedReason(github, nested)).toBe("Can't move under its own child");
    expect(agentRunLinkBlockedReason(glm, glm)).toBe("A chat cannot be its own parent");
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

describe("agent appearance", () => {
  it("prefers the agent's own color, then cycles the palette by library position", () => {
    const second = { ...profile, profileId: "review" };
    expect(agentColorFor({ ...profile, color: "#123456" }, [profile])).toBe("#123456");
    expect(agentColorFor(second, [profile, second])).toBe(agentColors[1]);
    expect(agentColorFor(second, [])).toBe(agentColors[0]);
  });

  it("falls back to the orb for missing or unrecognized icons", () => {
    expect(agentIconKey("shield")).toBe("shield");
    expect(agentIconKey(undefined)).toBe("orb");
    expect(agentIconKey("rocket")).toBe("orb");
    expect(agentIconKey("toString")).toBe("orb");
  });
});
