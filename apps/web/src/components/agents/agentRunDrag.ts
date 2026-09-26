import { createContext } from "react";

export const AGENT_CHILD_DRAG_PREFIX = "child:";
/** Cards that cannot reorder (pinned, settled, reorder-less environment) only link under another run. */
export const AGENT_LINK_DRAG_PREFIX = "link:";
/** Marks a card's wrapper so a pointer hit test can find the run under it. */
export const AGENT_NEST_KEY_ATTRIBUTE = "data-agent-nest-key";

/** Lets cards and their sub-run rows join the surrounding SortableAgentThreads drag. */
export const AgentRunDragContext = createContext<{
  /** Sub-run rows are draggable only inside a SortableAgentThreads list. */
  readonly childDragEnabled: boolean;
  readonly dragging: boolean;
  /** A reorder is being saved; drags pause until it lands. */
  readonly saving: boolean;
}>({ childDragEnabled: false, dragging: false, saving: false });

/**
 * Card whose header the dragged run would be linked under. Kept apart from
 * AgentRunDragContext so hovering only re-renders the card wrappers.
 */
export const AgentNestTargetContext = createContext<string | null>(null);

export const agentChildDragId = (key: string) => `${AGENT_CHILD_DRAG_PREFIX}${key}`;
