import {
  agentRunLinkBlockedReason,
  agentRunLinkTargets,
} from "@t3tools/client-runtime/state/agents";

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
 * Why `child` cannot move under `target`, or null when it can. Both the rule
 * and the wording are the shared ones web uses.
 */
export function parentRejection(
  child: ParentLink,
  target: ParentLink & { readonly title: string },
  all: readonly ParentLink[],
): string | null {
  return agentRunLinkTargets(child, all).has(parentLinkKey(target))
    ? null
    : agentRunLinkBlockedReason(child, target);
}
