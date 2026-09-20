import { memo, useEffect, useRef, useState } from "react";
import { ActivityIcon } from "lucide-react";
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
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";
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
  const settledMessages = props.turn?.state === "running" ? null : props.messages;
  const settledActivities = props.turn?.state === "running" ? null : props.activities;
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    const update = () => {
      if (document.hidden || !latest.current.available) return;
      setSnapshot(deriveThreadActivity(latest.current, Date.now()));
    };
    update();
    const interval = props.turn?.state === "running" ? setInterval(update, 1000) : undefined;
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
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
    <div className="flex justify-end px-2 py-1" data-thread-activity-panel="true">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 min-w-0 max-w-full gap-1.5 text-xs text-muted-foreground tabular-nums"
              aria-label="Thread activity details"
            />
          }
        >
          <ActivityIcon className="size-3.5 shrink-0" />
          <span className="truncate max-w-64">
            {!props.available
              ? "Activity offline"
              : snapshot
                ? threadActivityLabel(snapshot)
                : "Thread activity"}
          </span>
          {snapshot ? (
            <span className="shrink-0">· {formatActivityDuration(snapshot.elapsedMs)}</span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup
          {...composerFloatingLayerProps}
          side="top"
          align="end"
          className="w-80 text-sm"
        >
          <div className="space-y-3">
            <div className="flex justify-between gap-3 font-medium">
              <span>Thread activity</span>
              <span className="tabular-nums">
                {snapshot ? formatActivityDuration(snapshot.elapsedMs) : "—"}
              </span>
            </div>
            {!props.available ? (
              <p className="text-xs text-muted-foreground">
                Disconnected. Showing the last received activity.
              </p>
            ) : snapshot?.running ? (
              <p className="text-xs break-words">
                {threadActivityLabel(snapshot)} · {formatActivityDuration(snapshot.currentPhaseMs)}
              </p>
            ) : null}
            <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              {ACTIVITY_PHASES.map((phase) => (
                <span
                  key={phase}
                  className={colors[phase]}
                  style={{
                    width: `${snapshot?.elapsedMs ? (snapshot.durations[phase] / snapshot.elapsedMs) * 100 : 0}%`,
                  }}
                />
              ))}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs tabular-nums">
              {ACTIVITY_PHASES.map((phase) => (
                <div key={phase} className="contents">
                  <dt className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${colors[phase]}`} />
                    {ACTIVITY_LABELS[phase]}
                  </dt>
                  <dd className="text-right">
                    {snapshot ? formatActivityDuration(snapshot.durations[phase]) : "—"}
                  </dd>
                </div>
              ))}
              <dt>Tools finished</dt>
              <dd className="text-right">
                {snapshot ? `${snapshot.finishedTools} / ${snapshot.totalTools}` : "—"}
              </dd>
              {snapshot?.failedTools ? (
                <>
                  <dt>Tools failed</dt>
                  <dd className="text-right">{snapshot.failedTools}</dd>
                </>
              ) : null}
            </dl>
            {snapshot && snapshot.activeTools.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {snapshot.activeTools.slice(0, 3).map((tool) => (
                  <li key={tool.id} className="truncate">
                    {tool.title} · {formatActivityDuration(tool.elapsedMs)}
                  </li>
                ))}
                {snapshot.activeTools.length > 3 ? (
                  <li>+{snapshot.activeTools.length - 3} more</li>
                ) : null}
              </ul>
            ) : null}
            <div className="border-t pt-2 text-xs text-muted-foreground">
              {usage?.outputTokens !== undefined ? (
                <>
                  <div>
                    Provider output: {usage.outputTokens.toLocaleString()} tokens
                    {usage.usageStatus === "partial" ? " (partial)" : ""}
                  </div>
                  <div>
                    Reasoning included:{" "}
                    {usage.reasoningTokens?.toLocaleString() ?? "not reported separately"}
                  </div>
                  {usage.hasSubagents ? <div>Token counts cover the main agent only.</div> : null}
                </>
              ) : (
                <div>
                  {snapshot?.running
                    ? "Provider token totals appear when the turn finishes, if reported."
                    : "Provider token totals not reported for this turn."}
                </div>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{ACTIVITY_EXPLANATION}</p>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
});
