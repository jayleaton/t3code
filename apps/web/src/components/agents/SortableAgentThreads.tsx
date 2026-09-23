import { useCallback, useRef, useState, type ReactNode } from "react";
import { closestCenter, DndContext, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis, restrictToFirstScrollableAncestor } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  readEnvironmentSupportsActiveReorder,
  readThreadShell,
  useThreadShells,
} from "../../state/entities";
import { planSidebarThreadDrop } from "../Sidebar.logic";
import { SidebarDragLifecycle, SidebarPointerSensor } from "../Sidebar.pointer";
import { SortableThreadRow } from "../SortableThreadRow";
import { stackedThreadToast, toastManager } from "../ui/toast";

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Agents use the sidebar's pointer lifecycle, sortable rows, and persisted drop planner. */
export function SortableAgentThreads({
  threads,
  children,
}: {
  threads: readonly EnvironmentThreadShell[];
  children: (thread: EnvironmentThreadShell, dragging: boolean) => ReactNode;
}) {
  const all = useThreadShells();
  const { reorderActiveThread } = useThreadActions();
  const sensor = useRef<SidebarPointerSensor | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const attach = useCallback((value: SidebarPointerSensor) => {
    sensor.current = value;
  }, []);
  const finish = useCallback(() => {
    sensor.current = null;
    setDragging(false);
  }, []);
  const cancel = useCallback(() => sensor.current?.cancel(), []);
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, {
      distance: 6,
      onAttach: attach,
      onFinish: finish,
    }),
  );
  const active = threads.filter((thread) => thread.pinnedAt == null && thread.settledAt === null);
  const ids = active.map(keyOf);
  const onDragEnd = async ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const from = ids.indexOf(String(dragged.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const fresh = all.flatMap((thread) => {
      const current = readThreadShell(scopeThreadRef(thread.environmentId, thread.id));
      return current ? [current] : [];
    });
    const byKey = new Map(fresh.map((thread) => [keyOf(thread), thread]));
    // A lifecycle transition during a drag must not move a pin or a settled chat.
    if (
      ids.some((id) => {
        const thread = byKey.get(id);
        return !thread || thread.pinnedAt != null || thread.settledAt !== null;
      })
    )
      return;
    const plan = planSidebarThreadDrop({
      activeKey: String(dragged.id),
      activeSection: "active",
      target: { section: "active", activeOrder: arrayMove(ids, from, to), pinnedOrder: [] },
      pinnedOrder: [],
      pinnedKeysById: new Map(),
      activeOrder: ids,
      activeKeysById: new Map(fresh.map((thread) => [keyOf(thread), thread.activeOrderKey])),
      activeReorderableKeys: new Set(
        fresh
          .filter((thread) => readEnvironmentSupportsActiveReorder(thread.environmentId))
          .map(keyOf),
      ),
    });
    if (plan.kind !== "move-active") return;
    setSaving(true);
    try {
      for (const { id, orderKey } of plan.assignments) {
        const thread = byKey.get(id)!;
        const result = await reorderActiveThread(
          scopeThreadRef(thread.environmentId, thread.id),
          orderKey,
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              title: "Failed to move chat",
              description: error instanceof Error ? error.message : "Try again.",
              type: "error",
            }),
          );
          break;
        }
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={() => setDragging(true)}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
    >
      <SidebarDragLifecycle onUnmount={cancel} />
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {threads.map((thread) =>
          thread.pinnedAt != null || thread.settledAt !== null ? (
            <div key={keyOf(thread)}>{children(thread, dragging)}</div>
          ) : (
            <SortableThreadRow
              key={keyOf(thread)}
              id={keyOf(thread)}
              disabled={saving || !readEnvironmentSupportsActiveReorder(thread.environmentId)}
            >
              {({ setNodeRef, listeners, transform, transition, isDragging }) => (
                <div
                  ref={setNodeRef}
                  {...listeners}
                  style={{
                    transform: CSS.Transform.toString(transform),
                    transition,
                    position: "relative",
                    zIndex: isDragging ? 1 : undefined,
                    touchAction: "pan-x",
                    userSelect: dragging ? "none" : undefined,
                  }}
                >
                  {children(thread, dragging)}
                </div>
              )}
            </SortableThreadRow>
          ),
        )}
      </SortableContext>
    </DndContext>
  );
}
