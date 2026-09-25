import { createContext } from "react";

export const AGENT_NEST_DROP_PREFIX = "nest:";
export const AGENT_CHILD_DRAG_PREFIX = "child:";

/** Lets cards and their sub-run rows join the surrounding SortableAgentThreads drag. */
export const AgentRunDragContext = createContext<{
  /** Sub-run rows are draggable only inside a SortableAgentThreads list. */
  readonly childDragEnabled: boolean;
  /** Card whose header the dragged run would be linked under. */
  readonly nestTargetKey: string | null;
}>({ childDragEnabled: false, nestTargetKey: null });

export const agentChildDragId = (key: string) => `${AGENT_CHILD_DRAG_PREFIX}${key}`;
