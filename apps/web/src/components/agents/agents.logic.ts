import {
  planPinnedMove,
  sortActiveThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { McpGatewayProfile } from "@t3tools/contracts";

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

export function agentThreadStatus(thread: EnvironmentThreadShell) {
  if (thread.settledAt !== null) return "done";
  // Questions and approvals arrive mid-turn, so they outrank the running turn.
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running")
    return "running";
  if (thread.session?.status === "starting") return "queued";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "error";
  // A turn can settle while native background work runs on, as in the thread
  // sidebar: sub-agent fleets still count as work, watch loops as monitoring.
  if (thread.backgroundLiveness === "working") return "running";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  if (thread.latestTurn?.state === "completed") return "done";
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
  const completedAt = thread.latestTurn?.completedAt;
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
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    .toSorted(
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
  | "parentEnvironmentId"
  | "createdAt"
  | "settledAt"
  | "pinnedAt"
  | "archivedAt"
  | "activeOrderKey"
  | "unsettledAt"
>;

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

type AgentRunList = "pinned" | "active" | "settled";

type AgentRunParent = Pick<
  AgentRun,
  "environmentId" | "id" | "parentThreadId" | "parentEnvironmentId"
>;

/** Key of the run's parent, which may live on another machine; null when it has none. */
export function agentRunParentKey(run: AgentRunParent): string | null {
  if (run.parentThreadId == null) return null;
  const environmentId = run.parentEnvironmentId ?? run.environmentId;
  if (environmentId === run.environmentId && run.parentThreadId === run.id) return null;
  return threadKey({ environmentId, id: run.parentThreadId });
}

/** Pinned first (latest pin on top), then active by arranged order, then settled. */
function sortSiblingRuns<T extends AgentRun>(runs: readonly T[]): T[] {
  const pinned = runs
    .filter((run) => run.pinnedAt != null && run.settledAt === null)
    .toSorted((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? ""));
  const active = sortActiveThreadsByOrderKey(
    runs.filter((run) => run.pinnedAt == null && run.settledAt === null),
  );
  const settled = runs
    .filter((run) => run.settledAt !== null)
    .toSorted((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
  return [...pinned, ...active, ...settled];
}

/**
 * Folds runs that another run created into the card of their nearest ancestor
 * on the board. Children come from every run, so a parent's card also shows
 * sub-runs of other agents and ones hidden by the current filter. A live card
 * holds children in any state; a settled card holds only settled children, so
 * live work never disappears into the collapsed settled shelf.
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

/**
 * Keys of the runs `child` may become a sub-run of, on any machine. A run
 * cannot move under itself, its current parent, or one of its own sub-runs.
 * Computed once per drag, not per pointer move.
 */
export function agentRunLinkTargets(
  child: AgentRunParent,
  all: readonly AgentRunParent[],
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

/**
 * Opens a run's menu. Sub-runs pass their siblings so Move up/down arranges
 * them within their parent instead of the board.
 */
export type AgentRunContextMenu = (
  thread: EnvironmentThreadShell,
  position: { x: number; y: number },
  siblings?: readonly EnvironmentThreadShell[],
) => Promise<void>;
