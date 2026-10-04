import type { ThreadId } from "@t3tools/contracts";

export interface ThreadParentLink {
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  /** Set when the parent lives on another environment, which this one cannot check. */
  readonly parentEnvironmentId: string | null;
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
