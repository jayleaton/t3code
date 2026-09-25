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
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running")
    return "running";
  if (thread.session?.status === "starting") return "queued";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "error";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.latestTurn?.state === "completed") return "done";
  return "idle";
}

export function agentThreadStatusLabel(status: ReturnType<typeof agentThreadStatus>) {
  return {
    done: "Done",
    running: "In progress",
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
  "environmentId" | "id" | "parentThreadId" | "createdAt" | "settledAt" | "pinnedAt" | "archivedAt"
>;

export interface AgentChildRun<T> {
  readonly thread: T;
  /** 0 for runs the card's own run created, 1 for theirs, and so on. */
  readonly depth: number;
}

type AgentRunList = "pinned" | "active" | "settled";

/**
 * Folds runs that another run created into the card of their nearest ancestor
 * on the board. Children come from every run, so a parent's card also shows
 * sub-runs of other agents and ones hidden by the current filter. A live card
 * holds children in any state; a settled card holds only settled children, so
 * live work never disappears into the collapsed settled shelf. Pinned runs
 * keep their own card.
 */
export function nestAgentRuns<T extends AgentRun>(input: {
  readonly lists: Readonly<Record<AgentRunList, readonly T[]>>;
  readonly all: readonly T[];
}): {
  readonly lists: Readonly<Record<AgentRunList, readonly T[]>>;
  readonly childrenByKey: ReadonlyMap<string, readonly AgentChildRun<T>[]>;
} {
  const listByKey = new Map<string, AgentRunList>();
  for (const list of ["pinned", "active", "settled"] as const) {
    for (const run of input.lists[list]) listByKey.set(threadKey(run), list);
  }
  const runByKey = new Map<string, T>();
  for (const run of [...input.all, ...input.lists.pinned, ...input.lists.active]) {
    if (run.archivedAt === null) runByKey.set(threadKey(run), run);
  }
  const parentKeyOf = (run: T) =>
    run.parentThreadId == null || run.parentThreadId === run.id
      ? null
      : threadKey({ environmentId: run.environmentId, id: run.parentThreadId });
  const anchorByKey = new Map<string, string | null>();
  const resolveAnchor = (run: T, visiting: Set<string>): string | null => {
    const key = threadKey(run);
    const cached = anchorByKey.get(key);
    if (cached !== undefined) return cached;
    const parentKey = parentKeyOf(run);
    const parent = parentKey === null ? undefined : runByKey.get(parentKey);
    let anchor: string | null = null;
    if (parent && parentKey !== null && run.pinnedAt == null && !visiting.has(parentKey)) {
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
  const childrenByKey = new Map<string, AgentChildRun<T>[]>();
  const collect = (parentKey: string, depth: number, into: AgentChildRun<T>[]) => {
    const children = (childrenByParent.get(parentKey) ?? []).toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const child of children) {
      into.push({ thread: child, depth });
      collect(threadKey(child), depth + 1, into);
    }
  };
  for (const anchor of new Set(anchorByKey.values())) {
    if (anchor === null) continue;
    const descendants: AgentChildRun<T>[] = [];
    collect(anchor, 0, descendants);
    childrenByKey.set(anchor, descendants);
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
