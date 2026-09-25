import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CornerDownRightIcon, UnlinkIcon } from "lucide-react";
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
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { checkAgentRunLink, isAgentRunNestDrop } from "./agents.logic";
import {
  AGENT_CHILD_DRAG_PREFIX,
  AGENT_NEST_DROP_PREFIX,
  AgentRunDragContext,
} from "./agentRunDrag";

const NEST_PREFIX = AGENT_NEST_DROP_PREFIX;
const CHILD_PREFIX = AGENT_CHILD_DRAG_PREFIX;

function NestTarget({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (setNodeRef: (element: HTMLElement | null) => void) => ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: `${NEST_PREFIX}${id}`, disabled });
  return children(setNodeRef);
}

type ChildDrop = { kind: "none" } | { kind: "detach" };

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
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [nestTargetKey, setNestTargetKey] = useState<string | null>(null);
  const [draggedChild, setDraggedChild] = useState<{ key: string; anchorKey: string } | null>(null);
  const childDrop = useRef<ChildDrop>({ kind: "none" });
  const [childDropHint, setChildDropHint] = useState<ChildDrop["kind"]>("none");
  const sensor = useRef<SidebarPointerSensor | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const attach = useCallback((value: SidebarPointerSensor) => {
    sensor.current = value;
  }, []);
  // The sensor finishes before dnd-kit reports the drop, so drop state is
  // cleared separately once the drop has been handled.
  const finish = useCallback(() => {
    sensor.current = null;
    setDragging(false);
  }, []);
  const clearDrop = useCallback(() => {
    setNestTargetKey(null);
    setDraggedChild(null);
    childDrop.current = { kind: "none" };
    setChildDropHint("none");
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
  const runByKey = new Map(all.map((thread) => [keyOf(thread), thread]));
  const draggedKey = (id: string | number) =>
    String(id).startsWith(CHILD_PREFIX) ? String(id).slice(CHILD_PREFIX.length) : String(id);

  // A pointer on another card's header links under it; anywhere else a card
  // reorders as before and a sub-run row detaches once it leaves its card.
  const collisionDetection: CollisionDetection = (args) => {
    const pointer = args.pointerCoordinates;
    const activeId = String(args.active.id);
    const dragged = runByKey.get(draggedKey(activeId));
    if (pointer && dragged) {
      for (const container of args.droppableContainers) {
        const id = String(container.id);
        if (!id.startsWith(NEST_PREFIX)) continue;
        const targetKey = id.slice(NEST_PREFIX.length);
        const target = runByKey.get(targetKey);
        const rect = args.droppableRects.get(container.id);
        const header = container.node.current
          ?.querySelector(".agent-thread")
          ?.getBoundingClientRect();
        if (
          target &&
          rect &&
          header &&
          targetKey !== keyOf(dragged) &&
          pointer.x >= rect.left &&
          pointer.x <= rect.left + rect.width &&
          isAgentRunNestDrop(pointer.y, header) &&
          checkAgentRunLink(dragged, target, all) === "ok"
        ) {
          return [{ id: container.id }];
        }
      }
    }
    if (activeId.startsWith(CHILD_PREFIX)) {
      const anchorKey = (args.active.data.current as { anchorKey?: string } | undefined)?.anchorKey;
      const anchor = args.droppableContainers.find(
        (container) => String(container.id) === `${NEST_PREFIX}${anchorKey}`,
      );
      const rect = anchor ? args.droppableRects.get(anchor.id) : undefined;
      const outside =
        pointer !== null &&
        rect !== undefined &&
        (pointer.y < rect.top ||
          pointer.y > rect.top + rect.height ||
          pointer.x < rect.left ||
          pointer.x > rect.left + rect.width);
      childDrop.current = outside ? { kind: "detach" } : { kind: "none" };
      return [];
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => !String(container.id).startsWith(NEST_PREFIX),
      ),
    });
  };

  const linkRun = async (child: EnvironmentThreadShell, parent: EnvironmentThreadShell | null) => {
    const result = await updateThreadMetadata({
      environmentId: child.environmentId,
      input: { threadId: child.id, parentThreadId: parent?.id ?? null },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          title: parent ? "Failed to link chat" : "Failed to detach chat",
          description: error instanceof Error ? error.message : "Try again.",
          type: "error",
        }),
      );
    }
  };

  const onDragEnd = async ({ active: dragged, over }: DragEndEvent) => {
    const drop = childDrop.current;
    const run = runByKey.get(draggedKey(dragged.id));
    if (over && String(over.id).startsWith(NEST_PREFIX)) {
      const target = runByKey.get(String(over.id).slice(NEST_PREFIX.length));
      if (run && target) await linkRun(run, target);
      return;
    }
    if (String(dragged.id).startsWith(CHILD_PREFIX)) {
      if (run && drop.kind === "detach") await linkRun(run, null);
      return;
    }
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
  const draggedChildRun = draggedChild ? runByKey.get(draggedChild.key) : undefined;
  const nestTarget = nestTargetKey ? runByKey.get(nestTargetKey) : undefined;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={({ active: started }) => {
        setDragging(true);
        const anchorKey = (started.data.current as { anchorKey?: string } | undefined)?.anchorKey;
        if (String(started.id).startsWith(CHILD_PREFIX) && anchorKey) {
          setDraggedChild({ key: draggedKey(started.id), anchorKey });
        }
      }}
      onDragMove={() => setChildDropHint(childDrop.current.kind)}
      onDragOver={({ over }) =>
        setNestTargetKey(
          over && String(over.id).startsWith(NEST_PREFIX)
            ? String(over.id).slice(NEST_PREFIX.length)
            : null,
        )
      }
      onDragEnd={(event) => void onDragEnd(event).finally(clearDrop)}
      onDragCancel={() => {
        finish();
        clearDrop();
      }}
    >
      <SidebarDragLifecycle onUnmount={cancel} />
      <AgentRunDragContext.Provider value={{ childDragEnabled: !saving, nestTargetKey }}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {threads.map((thread) =>
            thread.pinnedAt != null || thread.settledAt !== null ? (
              <div key={keyOf(thread)}>{children(thread, dragging)}</div>
            ) : (
              <NestTarget key={keyOf(thread)} id={keyOf(thread)} disabled={saving}>
                {(setNestRef) => (
                  <SortableThreadRow
                    id={keyOf(thread)}
                    disabled={saving || !readEnvironmentSupportsActiveReorder(thread.environmentId)}
                  >
                    {({ setNodeRef, listeners, transform, transition, isDragging }) => (
                      <div
                        ref={(element) => {
                          setNodeRef(element);
                          setNestRef(element);
                        }}
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
                )}
              </NestTarget>
            ),
          )}
        </SortableContext>
      </AgentRunDragContext.Provider>
      <DragOverlay dropAnimation={null}>
        {draggedChildRun ? (
          <div className="agent-child-drag">
            {nestTarget ? (
              <CornerDownRightIcon size={12} aria-hidden="true" />
            ) : childDropHint === "detach" ? (
              <UnlinkIcon size={12} aria-hidden="true" />
            ) : null}
            <span className="agent-child-drag-title">{draggedChildRun.title}</span>
            <span className="agent-child-drag-hint">
              {nestTarget
                ? `Link under ${nestTarget.title}`
                : childDropHint === "detach"
                  ? "Detach"
                  : "Drag out to detach"}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
