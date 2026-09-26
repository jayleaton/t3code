import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  useDraggable,
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
import { agentRunDropZone, agentRunLinkTargets, agentRunReorderOver } from "./agents.logic";
import {
  AGENT_CHILD_DRAG_PREFIX,
  AGENT_LINK_DRAG_PREFIX,
  AGENT_NEST_KEY_ATTRIBUTE,
  AgentNestTargetContext,
  AgentRunDragContext,
} from "./agentRunDrag";

const CHILD_PREFIX = AGENT_CHILD_DRAG_PREFIX;
const LINK_PREFIX = AGENT_LINK_DRAG_PREFIX;

const nestWrapperOf = (key: string) =>
  document.querySelector(`[${AGENT_NEST_KEY_ATTRIBUTE}="${window.CSS.escape(key)}"]`);

/**
 * The card under the pointer, other than the dragged one. One hit test per
 * move: the dragged card rides under the pointer, so it is skipped and what
 * lies beneath decides. Cards are hit where they are drawn, so a card the
 * list has shifted out of the way is no longer under the pointer.
 */
function cardAt(
  pointer: { x: number; y: number },
  draggedKey: string,
): { key: string; rect: DOMRect } | null {
  for (const element of document.elementsFromPoint(pointer.x, pointer.y)) {
    const wrapper = element.closest(`[${AGENT_NEST_KEY_ATTRIBUTE}]`);
    const key = wrapper?.getAttribute(AGENT_NEST_KEY_ATTRIBUTE);
    if (!wrapper || !key || key === draggedKey) continue;
    return { key, rect: wrapper.getBoundingClientRect() };
  }
  return null;
}

type ChildDrop = { kind: "none" } | { kind: "detach" };

const keyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Pinned, settled, and reorder-less environments' cards keep their place and only link. */
const isReorderable = (thread: EnvironmentThreadShell) =>
  thread.pinnedAt == null &&
  thread.settledAt === null &&
  readEnvironmentSupportsActiveReorder(thread.environmentId);

/**
 * One drag surface for a list of agent chats: active cards reorder (the
 * sidebar's pointer lifecycle and persisted drop planner), and any card or
 * sub-run row can be linked under another run or detached from its parent.
 * `active` is the reorderable list rendered by SortableAgentThreads inside.
 *
 * Both gestures follow the pointer over the card beneath it: the middle of a
 * card links, its edges reorder (see agentRunDropZone). Reordering is not
 * left to the dragged card's center, which swapped a neighbour away before
 * the pointer could reach it.
 *
 * Link targets are not dnd-kit droppables. A sortable item loses its
 * transform whenever `over` is not a list item, so hovering a header would
 * snap every card, the dragged one included, back to its resting place.
 * Instead the hovered header is tracked on the side and `over` stays on the
 * last list position, which keeps the arrangement still under the pointer.
 */
export function AgentRunDragArea({
  active: activeThreads,
  children,
}: {
  active: readonly EnvironmentThreadShell[];
  children: ReactNode;
}) {
  const all = useThreadShells();
  const { reorderActiveThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const nestTarget = useRef<string | null>(null);
  const [nestTargetKey, setNestTargetKey] = useState<string | null>(null);
  const linkTargets = useRef<{ key: string; targets: ReadonlySet<string> } | null>(null);
  const lastSortOver = useRef<string | null>(null);
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
    nestTarget.current = null;
    setNestTargetKey(null);
    linkTargets.current = null;
    lastSortOver.current = null;
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
  const ids = activeThreads.filter(isReorderable).map(keyOf);
  const runByKey = new Map(all.map((thread) => [keyOf(thread), thread]));
  const draggedKey = (id: string | number) => {
    const value = String(id);
    for (const prefix of [CHILD_PREFIX, LINK_PREFIX]) {
      if (value.startsWith(prefix)) return value.slice(prefix.length);
    }
    return value;
  };

  // Valid parents depend only on the dragged run, so they are worked out once per drag.
  const linkTargetsFor = (key: string) => {
    if (linkTargets.current?.key !== key) {
      const dragged = runByKey.get(key);
      linkTargets.current = {
        key,
        targets: dragged ? agentRunLinkTargets(dragged, all) : new Set(),
      };
    }
    return linkTargets.current.targets;
  };

  const collisionDetection: CollisionDetection = (args) => {
    const pointer = args.pointerCoordinates;
    const activeId = String(args.active.id);
    const key = draggedKey(activeId);
    const reorders = !activeId.startsWith(CHILD_PREFIX) && !activeId.startsWith(LINK_PREFIX);
    const card = pointer ? cardAt(pointer, key) : null;
    const zone =
      pointer && card
        ? agentRunDropZone(pointer.y, card.rect, {
            nest: linkTargetsFor(key).has(card.key),
            reorder: reorders,
          })
        : null;
    nestTarget.current = card && zone === "nest" ? card.key : null;
    if (activeId.startsWith(CHILD_PREFIX)) {
      // A sub-run row detaches once it leaves the card it is listed under.
      const anchorKey = (args.active.data.current as { anchorKey?: string } | undefined)?.anchorKey;
      const rect = anchorKey ? nestWrapperOf(anchorKey)?.getBoundingClientRect() : undefined;
      const outside =
        nestTarget.current === null &&
        pointer !== null &&
        rect !== undefined &&
        (pointer.y < rect.top ||
          pointer.y > rect.bottom ||
          pointer.x < rect.left ||
          pointer.x > rect.right);
      childDrop.current = outside ? { kind: "detach" } : { kind: "none" };
      return [];
    }
    if (!reorders) return [];
    if (card && (zone === "before" || zone === "after")) {
      lastSortOver.current =
        agentRunReorderOver(ids, activeId, card.key, zone) ?? lastSortOver.current;
    }
    // Between cards, or while linking, the arrangement holds still under the pointer.
    return lastSortOver.current === null ? [] : [{ id: lastSortOver.current }];
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
    const targetKey = nestTarget.current;
    const run = runByKey.get(draggedKey(dragged.id));
    if (targetKey !== null) {
      const target = runByKey.get(targetKey);
      if (run && target) await linkRun(run, target);
      return;
    }
    if (String(dragged.id).startsWith(CHILD_PREFIX)) {
      if (run && drop.kind === "detach") await linkRun(run, null);
      return;
    }
    if (String(dragged.id).startsWith(LINK_PREFIX)) return;
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
  const dragContext = useMemo(
    () => ({ childDragEnabled: !saving, dragging, saving }),
    [dragging, saving],
  );
  const draggedChildRun = draggedChild ? runByKey.get(draggedChild.key) : undefined;
  const nestTargetRun = nestTargetKey ? runByKey.get(nestTargetKey) : undefined;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
      onDragStart={({ active: started }) => {
        setDragging(true);
        lastSortOver.current = String(started.id);
        const anchorKey = (started.data.current as { anchorKey?: string } | undefined)?.anchorKey;
        if (String(started.id).startsWith(CHILD_PREFIX) && anchorKey) {
          setDraggedChild({ key: draggedKey(started.id), anchorKey });
        } else if (String(started.id).startsWith(LINK_PREFIX)) {
          setDraggedChild({ key: draggedKey(started.id), anchorKey: "" });
        }
      }}
      // Both setters bail out when unchanged, so a move re-renders only on a change.
      onDragMove={() => {
        setNestTargetKey(nestTarget.current);
        setChildDropHint(childDrop.current.kind);
      }}
      onDragEnd={(event) => void onDragEnd(event).finally(clearDrop)}
      onDragCancel={() => {
        finish();
        clearDrop();
      }}
    >
      <SidebarDragLifecycle onUnmount={cancel} />
      <AgentRunDragContext.Provider value={dragContext}>
        <AgentNestTargetContext.Provider value={nestTargetKey}>
          {children}
        </AgentNestTargetContext.Provider>
      </AgentRunDragContext.Provider>
      {/* Mounted only for these drags: while any overlay is up, a sortable card
          stops following the pointer and jumps between slots instead. */}
      {draggedChildRun ? (
        <DragOverlay dropAnimation={null}>
          <div className="agent-child-drag">
            {nestTargetRun ? (
              <CornerDownRightIcon size={12} aria-hidden="true" />
            ) : childDropHint === "detach" ? (
              <UnlinkIcon size={12} aria-hidden="true" />
            ) : null}
            <span className="agent-child-drag-title">{draggedChildRun.title}</span>
            <span className="agent-child-drag-hint">
              {nestTargetRun
                ? `Link under ${nestTargetRun.title}`
                : draggedChild?.anchorKey === ""
                  ? "Drop on a chat to link"
                  : childDropHint === "detach"
                    ? "Detach"
                    : "Drag out to detach"}
            </span>
          </div>
        </DragOverlay>
      ) : null}
    </DndContext>
  );
}

/** The reorderable active cards; must render inside an AgentRunDragArea. */
export function SortableAgentThreads({
  threads,
  children,
}: {
  threads: readonly EnvironmentThreadShell[];
  children: (thread: EnvironmentThreadShell, dragging: boolean) => ReactNode;
}) {
  const { dragging, saving } = useContext(AgentRunDragContext);
  const nestTargetKey = useContext(AgentNestTargetContext);
  const ids = threads.filter(isReorderable).map(keyOf);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {threads.map((thread) =>
        !isReorderable(thread) ? (
          <LinkableAgentCard key={keyOf(thread)} thread={thread}>
            {children(thread, dragging)}
          </LinkableAgentCard>
        ) : (
          <SortableThreadRow key={keyOf(thread)} id={keyOf(thread)} disabled={saving}>
            {({ setNodeRef, listeners, transform, transition, isDragging }) => (
              <div
                ref={setNodeRef}
                {...listeners}
                {...{ [AGENT_NEST_KEY_ATTRIBUTE]: keyOf(thread) }}
                data-nest-target={nestTargetKey === keyOf(thread) || undefined}
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
  );
}

/**
 * A card that cannot reorder (pinned, settled, or its environment cannot
 * reorder): it keeps its place, but other runs can be linked under it and it
 * can be dragged onto another card to link under that run.
 */
export function LinkableAgentCard({
  thread,
  children,
}: {
  thread: EnvironmentThreadShell;
  children: ReactNode;
}) {
  const { dragging, saving } = useContext(AgentRunDragContext);
  const nestTargetKey = useContext(AgentNestTargetContext);
  const key = keyOf(thread);
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `${LINK_PREFIX}${key}`,
    disabled: saving,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...{ [AGENT_NEST_KEY_ATTRIBUTE]: key }}
      data-nest-target={nestTargetKey === key || undefined}
      data-dragging={isDragging || undefined}
      style={{ touchAction: "pan-x", userSelect: dragging ? "none" : undefined }}
    >
      {children}
    </div>
  );
}
