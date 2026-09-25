import { createContext } from "react";

export const AGENT_NEST_DROP_PREFIX = "nest:";
export const AGENT_CHILD_DRAG_PREFIX = "child:";
/** Pinned and settled cards: they cannot reorder, only link under another run. */
export const AGENT_LINK_DRAG_PREFIX = "link:";

/** Lets cards and their sub-run rows join the surrounding SortableAgentThreads drag. */
export const AgentRunDragContext = createContext<{
  /** Sub-run rows are draggable only inside a SortableAgentThreads list. */
  readonly childDragEnabled: boolean;
  /** Card whose header the dragged run would be linked under. */
  readonly nestTargetKey: string | null;
  readonly dragging: boolean;
  /** A reorder is being saved; drags pause until it lands. */
  readonly saving: boolean;
}>({ childDragEnabled: false, nestTargetKey: null, dragging: false, saving: false });

export const agentChildDragId = (key: string) => `${AGENT_CHILD_DRAG_PREFIX}${key}`;
