import * as Haptics from "expo-haptics";
import {
  type ComponentRef,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View } from "react-native";

type ViewType = ComponentRef<typeof View>;
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { AgentAvatar } from "../../components/AgentAvatar";
import { AppText as Text } from "../../components/AppText";
import type { AgentAppearance } from "../../state/agents";
import { cn } from "../../lib/cn";
import { resolveParentDrop, type DropCard, type ParentDrop } from "./agent-parenting";

/** Long enough that a scroll never picks a card up, short enough to feel direct. */
const PICK_UP_DELAY_MS = 350;

export interface AgentCardDragSubject {
  readonly key: string;
  readonly title: string;
  readonly agent: AgentAppearance | null;
  readonly currentParentKey: string | null;
}

interface DragState {
  readonly subject: AgentCardDragSubject;
  readonly drop: ParentDrop;
}

interface AgentCardDragApi {
  readonly drag: DragState | null;
  readonly register: (key: string, view: ViewType | null) => void;
  readonly begin: (subject: AgentCardDragSubject, x: number, y: number) => void;
  readonly move: (x: number, y: number) => void;
  readonly end: (cancelled: boolean) => void;
}

const AgentCardDragContext = createContext<AgentCardDragApi | null>(null);

/**
 * Hosts long-press drag between agent cards. Card positions are measured once
 * when a card is picked up, so a drag costs nothing per frame beyond a hit test
 * and a state update only when the drop target changes.
 */
export function AgentCardDragProvider(props: {
  readonly children: ReactNode;
  /** Valid parents for the picked-up chat, from the shared link rules. */
  readonly linkTargetsFor: (key: string) => ReadonlySet<string>;
  readonly onDrop: (subject: AgentCardDragSubject, drop: ParentDrop) => void;
}) {
  const views = useRef(new Map<string, ViewType>());
  const cards = useRef<DropCard[]>([]);
  const targets = useRef<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const y = useSharedValue(0);
  const latest = useRef(props);
  latest.current = props;

  const update = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const resolve = useCallback(
    (subject: AgentCardDragSubject, pointerY: number) =>
      resolveParentDrop({
        draggedKey: subject.key,
        currentParentKey: subject.currentParentKey,
        pointerY,
        cards: cards.current,
        linkTargets: targets.current,
      }),
    [],
  );

  const api = useMemo<AgentCardDragApi>(
    () => ({
      drag,
      register: (key, view) => {
        if (view) views.current.set(key, view);
        else views.current.delete(key);
      },
      begin: (subject, _pointerX, pointerY) => {
        y.value = pointerY;
        targets.current = latest.current.linkTargetsFor(subject.key);
        cards.current = [];
        // Only mounted (visible) cards can be drop targets; recycled rows are off screen.
        for (const [key, view] of views.current) {
          view.measureInWindow((_, top, __, height) => {
            cards.current.push({ key, top, bottom: top + height });
          });
        }
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        update({ subject, drop: { kind: "none" } });
      },
      move: (_pointerX, pointerY) => {
        y.value = pointerY;
        const current = dragRef.current;
        if (!current) return;
        const drop = resolve(current.subject, pointerY);
        if (dropKey(drop) === dropKey(current.drop)) return;
        if (drop.kind === "nest") void Haptics.selectionAsync();
        update({ subject: current.subject, drop });
      },
      end: (cancelled) => {
        const current = dragRef.current;
        update(null);
        if (!current || cancelled) return;
        latest.current.onDrop(current.subject, current.drop);
      },
    }),
    [drag, resolve, update, y],
  );

  // The chip tracks the finger vertically and stays inset horizontally, so it
  // never runs off screen or hides the card under the finger.
  const chipStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value - 96 }] }));

  return (
    <AgentCardDragContext.Provider value={api}>
      <View className="flex-1">
        {props.children}
        {drag ? (
          <Animated.View
            pointerEvents="none"
            className="absolute left-6 right-6 top-0 flex-row items-center gap-2 rounded-full border border-border bg-card py-1.5 pe-4 ps-1.5 shadow-lg"
            style={chipStyle}
          >
            <AgentAvatar
              icon={drag.subject.agent?.icon}
              color={drag.subject.agent?.color ?? null}
              size={28}
            />
            <View className="min-w-0 shrink">
              <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                {drag.subject.title}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {dropHint(drag.drop)}
              </Text>
            </View>
          </Animated.View>
        ) : null}
      </View>
    </AgentCardDragContext.Provider>
  );
}

function dropKey(drop: ParentDrop) {
  return drop.kind === "nest"
    ? `nest:${drop.parentKey}`
    : drop.kind === "rejected"
      ? `rejected:${drop.targetKey}`
      : drop.kind;
}

function dropHint(drop: ParentDrop) {
  switch (drop.kind) {
    case "nest":
      return "Release to make it a child";
    case "detach":
      return "Release to remove from parent";
    case "rejected":
      return "Can't move under this chat";
    case "none":
      return "Drag onto a chat to nest it";
  }
}

/** How a card should look while some card is being dragged. */
export function useAgentCardDragState(key: string) {
  const api = useContext(AgentCardDragContext);
  const drag = api?.drag;
  if (!drag) return "idle" as const;
  if (drag.subject.key === key) return "lifted" as const;
  if (drag.drop.kind === "nest" && drag.drop.parentKey === key) return "target" as const;
  if (drag.drop.kind === "rejected" && drag.drop.targetKey === key) return "rejected" as const;
  return "idle" as const;
}

/** Makes its child a long-press drag source and a drop target. */
export function AgentCardDragSource(props: {
  readonly subject: AgentCardDragSubject;
  readonly enabled: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const api = useContext(AgentCardDragContext);
  // The API object changes with drag state; the gesture reads it at event time.
  const apiRef = useRef(api);
  apiRef.current = api;
  const latest = useRef(props);
  latest.current = props;
  const hasApi = api !== null;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(hasApi && props.enabled)
        .activateAfterLongPress(PICK_UP_DELAY_MS)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart((event) =>
          apiRef.current?.begin(latest.current.subject, event.absoluteX, event.absoluteY),
        )
        .onUpdate((event) => apiRef.current?.move(event.absoluteX, event.absoluteY))
        .onFinalize((_, success) => apiRef.current?.end(!success)),
    [hasApi, props.enabled],
  );
  const register = api?.register;
  const key = props.subject.key;
  const setRef = useCallback((view: ViewType | null) => register?.(key, view), [register, key]);
  return (
    <GestureDetector gesture={gesture}>
      <View ref={setRef} collapsable={false} className={cn(props.className)}>
        {props.children}
      </View>
    </GestureDetector>
  );
}
