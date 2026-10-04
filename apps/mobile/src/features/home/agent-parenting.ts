import { agentRunLinkTargets, agentRunParentKey } from "@t3tools/client-runtime/state/agents";

/** The fields the shared link rules read from a thread shell. */
type ParentLink = Parameters<typeof agentRunLinkTargets>[0];

export const parentLinkKey = (thread: { environmentId: string; id: string }) =>
  `${thread.environmentId}:${thread.id}`;

/** Where a card sits on screen while a drag is in progress, in window coordinates. */
export interface DropCard {
  readonly key: string;
  readonly top: number;
  readonly bottom: number;
}

export type ParentDrop =
  | { readonly kind: "nest"; readonly parentKey: string }
  | { readonly kind: "detach" }
  /** Over a card it can never move under, such as one of its own child chats. */
  | { readonly kind: "rejected"; readonly targetKey: string }
  | { readonly kind: "none" };

/**
 * What releasing a dragged chat at `pointerY` does. Over a card it may move
 * under, it nests; over its own card or current parent nothing changes; over
 * any other card it is rejected; and a child released between cards leaves
 * its parent, like dragging it out on web.
 */
export function resolveParentDrop(input: {
  readonly draggedKey: string;
  readonly currentParentKey: string | null;
  readonly pointerY: number;
  readonly cards: readonly DropCard[];
  readonly linkTargets: ReadonlySet<string>;
}): ParentDrop {
  const card = input.cards.find(
    (candidate) => input.pointerY >= candidate.top && input.pointerY <= candidate.bottom,
  );
  if (card && input.linkTargets.has(card.key)) return { kind: "nest", parentKey: card.key };
  if (card && (card.key === input.draggedKey || card.key === input.currentParentKey)) {
    return { kind: "none" };
  }
  if (card) return { kind: "rejected", targetKey: card.key };
  return input.currentParentKey === null ? { kind: "none" } : { kind: "detach" };
}

/**
 * Why `child` cannot move under `target`, or null when it can. Validity comes
 * from the shared agentRunLinkTargets, so mobile and web accept the same moves.
 */
export function parentRejection(
  child: ParentLink,
  target: ParentLink,
  all: readonly ParentLink[],
): string | null {
  const targetKey = parentLinkKey(target);
  if (agentRunLinkTargets(child, all).has(targetKey)) return null;
  if (targetKey === parentLinkKey(child)) return "A chat can't be its own parent.";
  if (targetKey === agentRunParentKey(child)) return "It's already a child of that chat.";
  return "A chat can't move under one of its own child chats.";
}

/** A parent change the board shows before the server confirms it. */
export interface PendingParent {
  readonly parentThreadId: ParentLink["parentThreadId"];
  readonly parentEnvironmentId: NonNullable<ParentLink["parentEnvironmentId"]> | null;
}

/**
 * Applies optimistic parent changes to the shells the board groups. An
 * override is dropped (by the caller) once the server confirms or rejects it,
 * so a failure simply falls back to the real shell.
 */
export function applyPendingParents<T extends ParentLink>(
  threads: readonly T[],
  pending: ReadonlyMap<string, PendingParent>,
): readonly T[] {
  if (pending.size === 0) return threads;
  return threads.map((thread) => {
    const override = pending.get(parentLinkKey(thread));
    if (!override) return thread;
    const { parentEnvironmentId: _previous, ...rest } = thread;
    return {
      ...rest,
      parentThreadId: override.parentThreadId,
      ...(override.parentEnvironmentId
        ? { parentEnvironmentId: override.parentEnvironmentId }
        : {}),
    } as T;
  });
}

/** True once the shell already shows the change, so the override can go. */
export function pendingParentSettled(thread: ParentLink, pending: PendingParent): boolean {
  if (pending.parentThreadId === null) return thread.parentThreadId == null;
  return (
    thread.parentThreadId === pending.parentThreadId &&
    (thread.parentEnvironmentId ?? thread.environmentId) ===
      (pending.parentEnvironmentId ?? thread.environmentId)
  );
}
