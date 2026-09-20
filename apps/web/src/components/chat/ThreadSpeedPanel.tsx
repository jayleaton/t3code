import { memo, useEffect, useRef, useState } from "react";
import { GaugeIcon } from "lucide-react";
import {
  createThreadSpeedTracker,
  formatThreadSpeed,
  formatSpeedDuration,
  THREAD_SPEED_EXPLANATION,
  type ThreadSpeedInput,
  type ThreadSpeedSnapshot,
} from "@t3tools/client-runtime/thread-speed";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

export const ThreadSpeedPanel = memo(function ThreadSpeedPanel(
  props: ThreadSpeedInput & { available: boolean },
) {
  const latest = useRef(props);
  const tracker = useRef(createThreadSpeedTracker());
  const [snapshot, setSnapshot] = useState<ThreadSpeedSnapshot | null>(null);
  const settledMessages = props.turn?.state === "running" ? null : props.messages;
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    const update = () => {
      if (document.hidden || !latest.current.available) {
        tracker.current.reset();
        setSnapshot(null);
        return;
      }
      setSnapshot(tracker.current.sample(latest.current, performance.now(), Date.now()));
    };
    update();
    const interval = props.turn?.state === "running" ? setInterval(update, 1000) : undefined;
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
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
    <div className="flex justify-end px-2 py-1" data-thread-speed-panel="true">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 text-xs text-muted-foreground tabular-nums"
              aria-label="Thread speed details"
            />
          }
        >
          <GaugeIcon className="size-3.5" />
          {props.available ? formatThreadSpeed(snapshot) : "Speed unavailable"}
          {!snapshot?.running && snapshot ? <span>avg</span> : null}
        </PopoverTrigger>
        <PopoverPopup
          {...composerFloatingLayerProps}
          side="top"
          align="end"
          className="w-72 text-sm"
        >
          <div className="space-y-3">
            <div className="font-medium">Thread speed</div>
            <dl className="grid grid-cols-2 gap-2 tabular-nums text-xs">
              <dt>{snapshot?.running ? "Live output" : "Turn average"}</dt>
              <dd className="text-right">
                {props.available ? formatThreadSpeed(snapshot) : "Unavailable"}
              </dd>
              <dt>First output</dt>
              <dd className="text-right">{formatSpeedDuration(snapshot?.firstOutputMs ?? null)}</dd>
              <dt>Elapsed</dt>
              <dd className="text-right">{formatSpeedDuration(snapshot?.elapsedMs ?? null)}</dd>
              <dt>Visible output</dt>
              <dd className="text-right">
                {snapshot ? `~${snapshot.estimatedOutputTokens.toLocaleString()} tokens` : "—"}
              </dd>
            </dl>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {THREAD_SPEED_EXPLANATION}
            </p>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
});
