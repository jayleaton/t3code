import type { ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { animateSidebarLayoutChanges } from "./Sidebar.logic";

// The row owns button semantics; omit dnd-kit ARIA without a keyboard sensor.
export type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

export function SortableThreadRow(props: {
  id: string;
  disabled: boolean;
  children: (bag: SortableThreadRowBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return props.children({ listeners, setNodeRef, transform, transition, isDragging });
}
