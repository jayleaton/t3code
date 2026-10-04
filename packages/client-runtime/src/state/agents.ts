import { planPinnedMove, sortActiveThreadsByOrderKey } from "./threadSort.ts";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import type { EnvironmentThreadShell } from "./shell.ts";
import type { EnvironmentId, McpGatewayProfile, ThreadId } from "@t3tools/contracts";

/** Palette an agent without its own color cycles through, matching the agent editor's swatches. */
export const agentColors = ["#f5b775", "#7bb5ff", "#b797ff", "#71d8bc", "#f293b7"];

/** Stable palette color for an agent, by its position in the full profile list. */
export function agentColorFor(
  profile: Pick<McpGatewayProfile, "profileId" | "color">,
  profiles: ReadonlyArray<Pick<McpGatewayProfile, "profileId">>,
): string {
  if (profile.color) return profile.color;
  const index = profiles.findIndex((item) => item.profileId === profile.profileId);
  return agentColors[(index < 0 ? 0 : index) % agentColors.length]!;
}

export type AgentIconKey = NonNullable<McpGatewayProfile["icon"]>;

/** Icon choices in the agent editor, with their display labels. */
export const agentIconLabels: Record<AgentIconKey, string> = {
  orb: "Orb",
  bot: "Robot",
  code: "Code",
  pen: "Pen",
  search: "Search",
  shield: "Shield",
  sparkles: "Sparkles",
  terminal: "Terminal",
};

/** The glyph a client draws for an agent; missing or unrecognized icons render as the orb. */
export function agentIconKey(icon: string | null | undefined): AgentIconKey {
  return icon && Object.hasOwn(agentIconLabels, icon) ? (icon as AgentIconKey) : "orb";
}

export function groupAgentThreads(
  profiles: ReadonlyArray<McpGatewayProfile>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  const groups = new Map<string, EnvironmentThreadShell[]>(
    profiles.map((profile) => [profile.profileId, []]),
  );
  const orphaned: EnvironmentThreadShell[] = [];
  for (const thread of threads) {
    if (!thread.profileSnapshot?.profileId) continue;
    (groups.get(thread.profileSnapshot.profileId) ?? orphaned).push(thread);
  }
  for (const group of [...groups.values(), orphaned]) {
    group.sort(
      (a, b) =>
        Number(a.settledAt !== null) - Number(b.settledAt !== null) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }
  return { groups, orphaned };
}

/** `childWorking`: a run under this one (see selectWorkingParentKeys) is still doing its work. */
export function agentThreadStatus(thread: EnvironmentThreadShell, childWorking = false) {
  if (thread.settledAt !== null) return "done";
  // Questions and approvals arrive mid-turn, so they outrank the running turn.
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.runtime?.status === "running" || thread.latestRun?.status === "running")
    return "running";
  if (thread.runtime?.status === "starting" || thread.runtime?.status === "preparing")
    return "queued";
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") return "error";
  // A turn can settle while native background work runs on: sub-agents are
  // still doing the work, while commands, monitors, and other tasks watch or wait.
  // Chats this one launched or delegated to are its work too.
  if (childWorking || thread.pendingBackgroundTasks.some((task) => task.kind === "subagent"))
    return "running";
  if (thread.pendingBackgroundTasks.length > 0) return "monitoring";
  if (thread.latestRun?.status === "completed") return "done";
  return "idle";
}

export function agentThreadStatusLabel(status: ReturnType<typeof agentThreadStatus>) {
  return {
    done: "Done",
    running: "In progress",
    monitoring: "Monitoring",
    queued: "Queued",
    idle: "Idle",
    error: "Error",
    attention: "Needs input",
  }[status];
}

export function isAgentChatInFocus(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  selected: boolean,
) {
  if (selected) return true;
  if (thread.settledAt !== null) return false;
  const status = agentThreadStatus(thread);
  if (status !== "done") return true;
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  // A chat created from the board may complete before it has ever been opened.
  return (
    !lastVisitedAt ||
    !Number.isFinite(Date.parse(lastVisitedAt)) ||
    Date.parse(completedAt) > Date.parse(lastVisitedAt)
  );
}

/** The workspace keeps completed chats visible until they are explicitly settled. */
export function selectAgentWorkspaceThreads(
  threads: readonly EnvironmentThreadShell[],
  profileId: string | null,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  const matches = threads
    .filter(
      (thread) =>
        (Boolean(thread.profileSnapshot?.profileId) || (profileId === null && search.length > 0)) &&
        (profileId === null || thread.profileSnapshot?.profileId === profileId) &&
        (!search ||
          [thread.title, ...threadPullRequestSearchTerms(thread)].some((term) =>
            term.toLocaleLowerCase().includes(search),
          )),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    active: sortActiveThreadsByOrderKey(matches.filter((thread) => thread.settledAt === null)),
    settled: matches.filter((thread) => thread.settledAt !== null),
  };
}

/** Explicit project selections must never fall back to a different workspace. */
export function resolveAgentTaskProject<T extends { environmentId: string; id: string }>(
  projects: ReadonlyArray<T>,
  environmentId: string,
  projectId: string,
): T | undefined {
  return projects.find(
    (project) => project.environmentId === environmentId && project.id === projectId,
  );
}

const threadKey = (thread: { environmentId: string; id: string }) =>
  `${thread.environmentId}:${thread.id}`;

/**
 * Pinned chats render above every filter and search, so they are selected from
 * the full workspace rather than the filtered list. Settled chats drop out of
 * the pinned shelf: "done" beats "keep on top".
 */
export function selectPinnedAgentThreads(threads: readonly EnvironmentThreadShell[]) {
  return threads
    .filter((thread) => thread.pinnedAt != null && thread.settledAt === null)
    .sort(
      (a, b) =>
        (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

/** Remove already-rendered pinned chats so the filtered list cannot duplicate them. */
export function excludePinnedAgentThreads<T extends { environmentId: string; id: string }>(
  threads: readonly T[],
  pinned: readonly { environmentId: string; id: string }[],
): readonly T[] {
  if (pinned.length === 0) return threads;
  const pinnedKeys = new Set(pinned.map(threadKey));
  return threads.filter((thread) => !pinnedKeys.has(threadKey(thread)));
}

/** Move within the displayed active stack, retaining hidden threads' reserved keys. */
export function planAgentThreadMove(
  visible: readonly EnvironmentThreadShell[],
  all: readonly EnvironmentThreadShell[],
  moved: EnvironmentThreadShell,
  direction: "up" | "down",
) {
  const active = sortActiveThreadsByOrderKey(
    visible.filter((thread) => thread.settledAt === null && thread.pinnedAt == null),
  );
  const byId = new Map(active.map((thread) => [threadKey(thread), thread]));
  const plan = planPinnedMove({
    orderedIds: active.map(threadKey),
    keysById: new Map(all.map((thread) => [threadKey(thread), thread.activeOrderKey])),
    movedId: threadKey(moved),
    direction,
  });
  return plan?.map(({ id, orderKey }) => ({ thread: byId.get(id)!, orderKey })) ?? null;
}

type AgentRun = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "lineage"
  | "createdAt"
  | "settledAt"
  | "pinnedAt"
  | "archivedAt"
  | "activeOrderKey"
  | "unsettledAt"
> &
  Partial<Pick<EnvironmentThreadShell, "parentEnvironmentId">>;

export interface AgentChildRun<T> {
  readonly thread: T;
  /** 0 for runs the card's own run created, 1 for theirs, and so on. */
  readonly depth: number;
  /** Runs sharing this run's parent, for Move up/down within that parent. */
  readonly siblings: readonly T[];
}

export interface AgentCardChildren<T> {
  /** Pinned first, then active in their arranged order, each with its own sub-runs. */
  readonly live: readonly AgentChildRun<T>[];
  /** Settled direct sub-runs (and theirs), shown last like the board's Settled shelf. */
  readonly settled: readonly AgentChildRun<T>[];
}

/** Sidebar cards summarize the whole fleet without mounting individual run rows. */
export function agentChildRunsSummary(runs: AgentCardChildren<EnvironmentThreadShell>) {
  let total = 0;
  let running = 0;
  let attention = 0;
  for (const group of [runs.live, runs.settled]) {
    for (const { thread } of group) {
      total += 1;
      const status = agentThreadStatus(thread);
      if (status === "running" || status === "queued" || status === "monitoring") running += 1;
      if (status === "attention" || status === "error") attention += 1;
    }
  }
  return [
    `${total} subagent${total === 1 ? "" : "s"}`,
    ...(running > 0 ? [`${running} running`] : []),
    ...(attention > 0 ? [`${attention} need${attention === 1 ? "s" : ""} attention`] : []),
  ].join(" · ");
}

/** Delegation is a lineage relationship, independent of the Agent profile used to run it. */
export function isAgentSubagentThread(run: Pick<AgentRun, "lineage">) {
  return run.lineage.relationshipToParent === "subagent" && run.lineage.parentThreadId !== null;
}

export function selectAgentSidebarThreads(threads: readonly EnvironmentThreadShell[]) {
  return threads.filter((thread) => !isAgentSubagentThread(thread));
}

type AgentRunList = "pinned" | "active" | "settled";

/** Pinned first (latest pin on top), then active by arranged order, then settled. */
function sortSiblingRuns<T extends AgentRun>(runs: readonly T[]): T[] {
  const pinned = runs
    .filter((run) => run.pinnedAt != null && run.settledAt === null)
    .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  const active = sortActiveThreadsByOrderKey(
    runs.filter((run) => run.pinnedAt == null && run.settledAt === null),
  );
  const settled = runs
    .filter((run) => run.settledAt !== null)
    .sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
  return [...pinned, ...active, ...settled];
}

/**
 * Folds runs that another run created into the card of their nearest ancestor
 * on the board, on the full board and in the open-chat rail alike. Children
 * come from every run, so a parent's card also shows sub-runs of other agents
 * and ones hidden by the current filter. A live card holds children in any
 * state; a settled card holds only settled children, so live work never
 * disappears into the collapsed settled shelf. Callers pass Agent chats only
 * (see selectAgentSidebarThreads): delegated subagents are never cards.
 */
export function nestAgentRuns<T extends AgentRun>(input: {
  readonly lists: Readonly<Record<AgentRunList, readonly T[]>>;
  readonly all: readonly T[];
}): {
  readonly lists: Readonly<Record<AgentRunList, readonly T[]>>;
  readonly childrenByKey: ReadonlyMap<string, AgentCardChildren<T>>;
} {
  const listByKey = new Map<string, AgentRunList>();
  for (const list of ["pinned", "active", "settled"] as const) {
    for (const run of input.lists[list]) listByKey.set(threadKey(run), list);
  }
  const runByKey = new Map<string, T>();
  for (const run of [...input.all, ...input.lists.pinned, ...input.lists.active]) {
    if (run.archivedAt === null) runByKey.set(threadKey(run), run);
  }
  const parentKeyOf = agentRunParentKey;
  const anchorByKey = new Map<string, string | null>();
  const resolveAnchor = (run: T, visiting: Set<string>): string | null => {
    const key = threadKey(run);
    const cached = anchorByKey.get(key);
    if (cached !== undefined) return cached;
    const parentKey = parentKeyOf(run);
    const parent = parentKey === null ? undefined : runByKey.get(parentKey);
    let anchor: string | null = null;
    if (parent && parentKey !== null && !visiting.has(parentKey)) {
      visiting.add(key);
      const candidate =
        resolveAnchor(parent, visiting) ?? (listByKey.has(parentKey) ? parentKey : null);
      visiting.delete(key);
      if (
        candidate !== null &&
        (listByKey.get(candidate) !== "settled" || run.settledAt !== null)
      ) {
        anchor = candidate;
      }
    }
    anchorByKey.set(key, anchor);
    return anchor;
  };
  const childrenByParent = new Map<string, T[]>();
  for (const run of runByKey.values()) {
    if (resolveAnchor(run, new Set()) === null) continue;
    const parentKey = parentKeyOf(run)!;
    childrenByParent.set(parentKey, [...(childrenByParent.get(parentKey) ?? []), run]);
  }
  const collect = (parentKey: string, depth: number, into: AgentChildRun<T>[]) => {
    const siblings = sortSiblingRuns(childrenByParent.get(parentKey) ?? []);
    for (const child of siblings) {
      into.push({ thread: child, depth, siblings });
      collect(threadKey(child), depth + 1, into);
    }
  };
  const childrenByKey = new Map<string, AgentCardChildren<T>>();
  for (const anchor of new Set(anchorByKey.values())) {
    if (anchor === null) continue;
    const live: AgentChildRun<T>[] = [];
    const settled: AgentChildRun<T>[] = [];
    const siblings = sortSiblingRuns(childrenByParent.get(anchor) ?? []);
    for (const child of siblings) {
      const into = child.settledAt === null ? live : settled;
      into.push({ thread: child, depth: 0, siblings });
      collect(threadKey(child), 1, into);
    }
    childrenByKey.set(anchor, { live, settled });
  }
  const keep = (runs: readonly T[]) =>
    runs.filter((run) => anchorByKey.get(threadKey(run)) == null);
  return {
    lists: {
      pinned: keep(input.lists.pinned),
      active: keep(input.lists.active),
      settled: keep(input.lists.settled),
    },
    childrenByKey,
  };
}

type AgentRunLink = Pick<
  AgentRun,
  "environmentId" | "id" | "parentThreadId" | "parentEnvironmentId"
>;

/** Key of the run `run` is nested under, which may be on another environment. */
export function agentRunParentKey(
  run: Pick<AgentRunLink, "environmentId" | "id" | "parentThreadId" | "parentEnvironmentId">,
): string | null {
  if (run.parentThreadId == null) return null;
  const environmentId = run.parentEnvironmentId ?? run.environmentId;
  if (environmentId === run.environmentId && run.parentThreadId === run.id) return null;
  return threadKey({ environmentId, id: run.parentThreadId });
}

// "monitoring": the child's turn ended but work it started runs on in the background.
const WORKING_STATUSES = new Set(["running", "queued", "attention", "monitoring"]);

/**
 * Keys of runs with work still going on below them, at any depth, so a parent
 * whose own turn finished does not read Done while its sub-runs work on.
 */
export function selectWorkingParentKeys(
  threads: readonly EnvironmentThreadShell[],
): ReadonlySet<string> {
  const parentKeyByKey = new Map<string, string | null>();
  for (const thread of threads) {
    if (thread.archivedAt === null)
      parentKeyByKey.set(threadKey(thread), agentRunParentKey(thread));
  }
  const working = new Set<string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || !WORKING_STATUSES.has(agentThreadStatus(thread))) continue;
    let parentKey = parentKeyByKey.get(threadKey(thread)) ?? null;
    while (parentKey !== null && !working.has(parentKey)) {
      working.add(parentKey);
      parentKey = parentKeyByKey.get(parentKey) ?? null;
    }
  }
  return working;
}

/** A parent change the board shows before the server confirms it. */
export interface AgentParentOverride {
  readonly parentThreadId: ThreadId | null;
  readonly parentEnvironmentId: EnvironmentId | null;
}

/**
 * Applies pending parent changes, keyed by the child's key, so a drag or
 * "Remove from parent" lands at once. Removing an entry rolls the run back to
 * the server's link, which is the only state a failed change can leave.
 */
export function applyAgentParentOverrides<T extends EnvironmentThreadShell>(
  threads: readonly T[],
  overrides: ReadonlyMap<string, AgentParentOverride>,
): readonly T[] {
  if (overrides.size === 0) return threads;
  return threads.map((thread) => {
    const override = overrides.get(threadKey(thread));
    if (!override || agentParentOverrideApplied(thread, override)) return thread;
    return {
      ...thread,
      parentThreadId: override.parentThreadId,
      parentEnvironmentId: override.parentEnvironmentId,
    };
  });
}

/** True when the shell already shows the parent an override asked for. */
export function agentParentOverrideApplied(
  thread: Pick<AgentRun, "parentThreadId" | "parentEnvironmentId">,
  override: AgentParentOverride,
): boolean {
  return (
    (thread.parentThreadId ?? null) === override.parentThreadId &&
    (override.parentThreadId === null ||
      (thread.parentEnvironmentId ?? null) === override.parentEnvironmentId)
  );
}

/**
 * The open-chat rail lists chats in focus. Their ancestors join it so a child
 * in focus still renders inside its parent's card instead of on its own.
 */
export function withAgentRunAncestors<T extends AgentRun>(
  inFocus: readonly T[],
  all: readonly T[],
): readonly T[] {
  const byKey = new Map(all.map((run) => [threadKey(run), run]));
  const included = new Set(inFocus.map(threadKey));
  const ancestors: T[] = [];
  for (const run of inFocus) {
    let parentKey = agentRunParentKey(run);
    while (parentKey !== null && !included.has(parentKey)) {
      const parent = byKey.get(parentKey);
      if (!parent || parent.archivedAt !== null || parent.settledAt !== null) break;
      included.add(parentKey);
      ancestors.push(parent);
      parentKey = agentRunParentKey(parent);
    }
  }
  return ancestors.length === 0 ? inFocus : [...inFocus, ...ancestors];
}

/**
 * Keys of the runs `child` may become a sub-run of, on any environment. A run cannot move
 * under itself, its current parent, or one of its own sub-runs. Computed once per drag, not
 * per pointer move.
 */
export function agentRunLinkTargets(
  child: AgentRunLink,
  all: readonly AgentRunLink[],
): ReadonlySet<string> {
  const childKeysByParent = new Map<string, string[]>();
  for (const run of all) {
    const parentKey = agentRunParentKey(run);
    if (parentKey === null) continue;
    const siblings = childKeysByParent.get(parentKey);
    if (siblings) siblings.push(threadKey(run));
    else childKeysByParent.set(parentKey, [threadKey(run)]);
  }
  const ownRuns = new Set<string>([threadKey(child)]);
  const pending: string[] = [threadKey(child)];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    for (const childKey of childKeysByParent.get(key) ?? []) {
      if (ownRuns.has(childKey)) continue;
      ownRuns.add(childKey);
      pending.push(childKey);
    }
  }
  const currentParent = agentRunParentKey(child);
  return new Set(all.map(threadKey).filter((key) => !ownRuns.has(key) && key !== currentParent));
}

/** Why `child` cannot link under `target`, a card agentRunLinkTargets left out. */
export function agentRunLinkBlockedReason(
  child: AgentRunLink & { readonly title?: string },
  target: AgentRunLink & { readonly title: string },
): string {
  if (threadKey(child) === threadKey(target)) return "A chat cannot be its own parent";
  if (agentRunParentKey(child) === threadKey(target)) return `Already under ${target.title}`;
  return "Can't move under its own sub-run";
}

export type AgentRunDropZone = "before" | "nest" | "after";

/** Share of a card's height, at each end, that reorders instead of linking. */
const AGENT_RUN_REORDER_EDGE = 0.25;

/**
 * Where a pointer over a card drops: the middle of the card links under that
 * run and its top and bottom edges reorder around it, so both gestures share
 * one drag. A card the run cannot link under reorders by halves, and a drag
 * that cannot reorder links anywhere on the card.
 */
export function agentRunDropZone(
  pointerY: number,
  card: { top: number; bottom: number },
  can: { nest: boolean; reorder: boolean },
): AgentRunDropZone | null {
  if (pointerY < card.top || pointerY > card.bottom) return null;
  const height = card.bottom - card.top;
  if (!can.reorder) return can.nest ? "nest" : null;
  const half = pointerY < card.top + height / 2 ? "before" : "after";
  if (!can.nest) return half;
  const edge = height * AGENT_RUN_REORDER_EDGE;
  if (pointerY < card.top + edge) return "before";
  if (pointerY > card.bottom - edge) return "after";
  return "nest";
}

/**
 * The sortable `over` id that places `activeId` before or after `targetId`.
 * dnd-kit moves the active item to `over`'s index, so the slot depends on
 * which side of the target the active item started.
 */
export function agentRunReorderOver(
  ids: readonly string[],
  activeId: string,
  targetId: string,
  zone: "before" | "after",
): string | null {
  const from = ids.indexOf(activeId);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0) return null;
  const insertAt = zone === "before" ? target : target + 1;
  return ids[from < insertAt ? insertAt - 1 : insertAt] ?? null;
}
