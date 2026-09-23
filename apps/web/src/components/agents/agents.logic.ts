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
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  if (thread.runtime?.status === "running" || thread.latestRun?.status === "running")
    return "running";
  if (thread.runtime?.status === "starting" || thread.runtime?.status === "preparing")
    return "queued";
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") return "error";
  if (thread.latestRun?.status === "completed") return "done";
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
