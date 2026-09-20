import { memo, useEffect, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import {
  deriveThreadActivity,
  formatActivityDuration,
  threadActivityLabel,
  ACTIVITY_PHASES,
  ACTIVITY_LABELS,
  ACTIVITY_EXPLANATION,
  type ThreadActivityInput,
  type ThreadActivitySnapshot,
} from "@t3tools/client-runtime/thread-activity-metrics";
import { AppText as Text } from "../../components/AppText";
const colors = {
  waiting: "bg-amber-400",
  tools: "bg-blue-400",
  thinking: "bg-violet-400",
  responding: "bg-emerald-400",
  working: "bg-muted-foreground/40",
};
export const ThreadActivityPanel = memo(function ThreadActivityPanel(
  props: ThreadActivityInput & { available: boolean },
) {
  const latest = useRef(props);
  const [snapshot, setSnapshot] = useState<ThreadActivitySnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const settledMessages = props.turn?.state === "running" ? null : props.messages;
  const settledActivities = props.turn?.state === "running" ? null : props.activities;
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    const update = () => {
      if (AppState.currentState !== "active" || !latest.current.available) return;
      setSnapshot(deriveThreadActivity(latest.current, Date.now()));
    };
    update();
    const interval = props.turn?.state === "running" ? setInterval(update, 1000) : undefined;
    const subscription = AppState.addEventListener("change", update);
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Lifecycle changes refresh immediately; streaming data is read once a second through the ref.
    props.turn?.turnId,
    props.turn?.state,
    props.turn?.completedAt,
    props.available,
    settledMessages,
    settledActivities,
  ]);
  if (!props.turn) return null;
  const usage = snapshot?.usage;
  return (
    <View className="px-4 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Thread activity details"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="self-end py-2 max-w-full"
      >
        <Text
          numberOfLines={1}
          className="text-xs text-muted-foreground"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {!props.available
            ? "Activity offline"
            : snapshot
              ? threadActivityLabel(snapshot)
              : "Thread activity"}
          {snapshot ? ` · ${formatActivityDuration(snapshot.elapsedMs)}` : ""} ·{" "}
          {expanded ? "Hide" : "Details"}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2 rounded-xl border border-border bg-card p-3">
          <Text className="text-sm font-medium">
            Thread activity · {snapshot ? formatActivityDuration(snapshot.elapsedMs) : "—"}
          </Text>
          {!props.available ? (
            <Text className="text-xs">Disconnected. Showing the last received activity.</Text>
          ) : snapshot?.running ? (
            <Text className="text-xs">
              {threadActivityLabel(snapshot)} · {formatActivityDuration(snapshot.currentPhaseMs)}
            </Text>
          ) : null}
          <View className="flex-row h-2 overflow-hidden rounded-full bg-muted" accessible={false}>
            {ACTIVITY_PHASES.map((phase) => (
              <View
                key={phase}
                className={colors[phase]}
                style={{
                  width: `${snapshot?.elapsedMs ? (snapshot.durations[phase] / snapshot.elapsedMs) * 100 : 0}%`,
                }}
              />
            ))}
          </View>
          {ACTIVITY_PHASES.map((phase) => (
            <View key={phase} className="flex-row justify-between">
              <Text className="text-xs">{ACTIVITY_LABELS[phase]}</Text>
              <Text className="text-xs">
                {snapshot ? formatActivityDuration(snapshot.durations[phase]) : "—"}
              </Text>
            </View>
          ))}
          <Text className="text-xs">
            Tools finished: {snapshot ? `${snapshot.finishedTools} / ${snapshot.totalTools}` : "—"}
            {snapshot?.failedTools ? ` · ${snapshot.failedTools} failed` : ""}
          </Text>
          {snapshot?.activeTools.slice(0, 3).map((tool) => (
            <Text key={tool.id} numberOfLines={1} className="text-xs text-muted-foreground">
              {tool.title} · {formatActivityDuration(tool.elapsedMs)}
            </Text>
          ))}
          <Text className="text-xs text-muted-foreground">
            {usage?.outputTokens !== undefined
              ? `Provider output: ${usage.outputTokens.toLocaleString()} tokens${usage.usageStatus === "partial" ? " (partial)" : ""}. Reasoning included: ${usage.reasoningTokens?.toLocaleString() ?? "not reported separately"}.${usage.hasSubagents ? " Token counts cover the main agent only." : ""}`
              : snapshot?.running
                ? "Provider token totals appear when the turn finishes, if reported."
                : "Provider token totals not reported for this turn."}
          </Text>
          <Text className="text-xs text-muted-foreground">{ACTIVITY_EXPLANATION}</Text>
        </View>
      ) : null}
    </View>
  );
});
