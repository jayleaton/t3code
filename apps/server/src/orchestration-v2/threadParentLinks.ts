import type { OrchestrationV2ParentRelationship, ThreadId } from "@t3tools/contracts";

export interface ThreadParentLink {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  /** Set when the parent lives on another environment, which this one cannot check. */
  readonly parentEnvironmentId: string | null;
  /** Stored kind; undefined for rows written before it was recorded. */
  readonly parentRelationship?: OrchestrationV2ParentRelationship | null | undefined;
  /** Owner of a thread a task spawned (lineage `"subagent"`), else null. */
  readonly spawnedByThreadId?: ThreadId | null | undefined;
  readonly creationSource?: string | undefined;
  readonly profileId?: string | null | undefined;
}

export interface ThreadParentRepair {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly parentRelationship: OrchestrationV2ParentRelationship | null;
}

/**
 * Children whose Agents-board parent link cannot be shown and should be
 * cleared: the parent is missing or deleted, the link points at the chat
 * itself, or the links form a cycle. `links` holds every live (not deleted)
 * thread. A cycle is broken once, at its smallest thread id, so the rest of
 * the chain keeps its parents.
 */
export function findBrokenThreadParentLinks(
  links: ReadonlyArray<ThreadParentLink>,
): ReadonlyArray<ThreadId> {
  const parentById = new Map<ThreadId, ThreadId | null>();
  for (const link of links) {
    parentById.set(link.threadId, link.parentEnvironmentId === null ? link.parentThreadId : null);
  }
  const broken = new Set<ThreadId>();
  for (const [threadId, parentThreadId] of parentById) {
    if (parentThreadId === null) continue;
    if (parentThreadId === threadId || !parentById.has(parentThreadId)) broken.add(threadId);
  }
  const done = new Set<ThreadId>();
  for (const start of parentById.keys()) {
    const path: ThreadId[] = [];
    const onPath = new Set<ThreadId>();
    let current: ThreadId | null = start;
    while (current !== null && !done.has(current) && !broken.has(current)) {
      if (onPath.has(current)) {
        const cycle = path.slice(path.indexOf(current));
        broken.add(cycle.reduce((min, id) => (id < min ? id : min)));
        break;
      }
      onPath.add(current);
      path.push(current);
      current = parentById.get(current) ?? null;
    }
    for (const id of path) done.add(id);
  }
  return [...broken].toSorted();
}

/**
 * Startup repairs that leave every live thread visible in exactly one place:
 * a card (top-level or nested in its parent's card) or its owner's Lineage.
 *
 * - A broken link (see findBrokenThreadParentLinks) makes the thread
 *   top-level, subagents included: a subagent whose owner is gone has no
 *   Lineage to appear in.
 * - A task-spawned thread stored before the kind was recorded is classified:
 *   one the user moved under another chat is a child (nesting is a child
 *   relationship); a delegate_task run as a named agent other than its owner's
 *   is a child; anything else, provider-native subagents included, is a
 *   subagent and gets its owner back as its parent.
 *
 * Other unrecorded rows read correctly through `threadParentRelationship`'s
 * fallback, so they are left as they are.
 */
export function planThreadParentRepairs(
  links: ReadonlyArray<ThreadParentLink>,
): ReadonlyArray<ThreadParentRepair> {
  const byId = new Map(links.map((link) => [link.threadId, link]));
  const broken = new Set(findBrokenThreadParentLinks(links));
  const repairs: ThreadParentRepair[] = [];
  const topLevel = (threadId: ThreadId) =>
    repairs.push({ threadId, parentThreadId: null, parentRelationship: null });
  for (const link of links) {
    const owner = link.spawnedByThreadId ?? null;
    if (link.parentRelationship !== undefined || owner === null) {
      if (broken.has(link.threadId)) topLevel(link.threadId);
      continue;
    }
    const moved =
      link.parentThreadId !== null &&
      (link.parentThreadId !== owner || link.parentEnvironmentId !== null);
    if (moved) {
      if (broken.has(link.threadId)) topLevel(link.threadId);
      else
        repairs.push({
          threadId: link.threadId,
          parentThreadId: link.parentThreadId,
          parentRelationship: "child",
        });
      continue;
    }
    const ownerLink = byId.get(owner);
    if (ownerLink === undefined) {
      topLevel(link.threadId);
      continue;
    }
    const namedAgent =
      link.creationSource !== "provider" &&
      link.profileId != null &&
      link.profileId !== (ownerLink.profileId ?? null);
    repairs.push({
      threadId: link.threadId,
      parentThreadId: owner,
      parentRelationship: namedAgent ? "child" : "subagent",
    });
  }
  return repairs.toSorted((left, right) =>
    left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0,
  );
}
