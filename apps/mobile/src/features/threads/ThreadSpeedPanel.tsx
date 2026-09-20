import { memo, useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import {
  createThreadSpeedTracker,
  formatThreadSpeed,
  formatSpeedDuration,
  THREAD_SPEED_EXPLANATION,
  type ThreadSpeedInput,
  type ThreadSpeedSnapshot,
} from "@t3tools/client-runtime/thread-speed";
import { AppText as Text } from "../../components/AppText";

export const ThreadSpeedPanel = memo(function ThreadSpeedPanel(
  props: ThreadSpeedInput & { available: boolean },
) {
  const latest = useRef(props);
  const tracker = useRef(createThreadSpeedTracker());
  const [snapshot, setSnapshot] = useState<ThreadSpeedSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const settledMessages = props.turn?.state === "running" ? null : props.messages;
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    const update = () => {
      if (AppState.currentState !== "active" || !latest.current.available) {
        tracker.current.reset();
        setSnapshot(null);
        return;
      }
      setSnapshot(tracker.current.sample(latest.current, performance.now(), Date.now()));
    };
    update();
    const interval = props.turn?.state === "running" ? setInterval(update, 1000) : undefined;
    const subscription = AppState.addEventListener("change", update);
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Resubscribe on lifecycle changes; streaming text is sampled through the ref once a second.
    props.turn?.turnId,
    props.turn?.state,
    props.turn?.completedAt,
    props.available,
    settledMessages,
  ]);
  if (!props.turn) return null;
  return (
    <View className="px-4 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Thread speed details"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="self-end py-2"
      >
        <Text className="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {props.available ? formatThreadSpeed(snapshot) : "Speed unavailable"}
          {snapshot && !snapshot.running ? " avg" : ""} · {expanded ? "Hide speed" : "Thread speed"}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2 rounded-xl border border-border bg-card p-3">
          <Text className="text-sm font-medium">Thread speed</Text>
          <Text className="text-xs">
            First output: {formatSpeedDuration(snapshot?.firstOutputMs ?? null)} · Elapsed:{" "}
            {formatSpeedDuration(snapshot?.elapsedMs ?? null)}
          </Text>
          <Text className="text-xs">
            Visible output:{" "}
            {snapshot ? `~${snapshot.estimatedOutputTokens.toLocaleString()} tokens` : "—"}
          </Text>
          <Text className="text-xs text-muted-foreground">{THREAD_SPEED_EXPLANATION}</Text>
        </View>
      ) : null}
    </View>
  );
});
