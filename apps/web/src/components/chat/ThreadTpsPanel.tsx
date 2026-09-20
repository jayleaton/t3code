import { memo, useMemo } from "react";
import { GaugeIcon } from "lucide-react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  latestModelThroughput,
  supportsModelThroughput,
} from "@t3tools/client-runtime/model-throughput";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

export const ThreadTpsPanel = memo(function ThreadTpsPanel(props: {
  turnId: string | undefined;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  provider: string | undefined;
  running: boolean;
  available: boolean;
}) {
  const sample = useMemo(
    () => latestModelThroughput(props.activities, props.turnId),
    [props.activities, props.turnId],
  );
  if (!props.turnId) return null;
  const supported = supportsModelThroughput(props.provider);
  const label = sample
    ? `${sample.tokensPerSecond.toFixed(1)} tok/s`
    : props.running && supported
      ? "Awaiting TPS"
      : "TPS unavailable";
  return (
    <div className="flex justify-end px-2 py-1" data-thread-tps-panel="true">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1.5 text-xs text-muted-foreground tabular-nums"
              aria-label="Tokens per second details"
            />
          }
        >
          <GaugeIcon className="size-3.5" />
          {label}
          {!props.available ? " · offline" : null}
        </PopoverTrigger>
        <PopoverPopup
          {...composerFloatingLayerProps}
          side="top"
          align="end"
          className="w-72 text-sm"
        >
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">Tokens per second</span>
              <span className="text-lg tabular-nums">
                {sample ? sample.tokensPerSecond.toFixed(1) : "—"}
              </span>
            </div>
            {sample ? (
              <>
                <div className="text-xs text-muted-foreground">
                  {sample.scope === "response"
                    ? "Last completed model response"
                    : "Completed turn API average"}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs tabular-nums">
                  <dt>Output tokens</dt>
                  <dd className="text-right">{sample.outputTokens.toLocaleString()}</dd>
                  <dt>API request time</dt>
                  <dd className="text-right">{(sample.durationMs / 1000).toFixed(2)}s</dd>
                  {sample.reasoningTokens !== undefined ? (
                    <>
                      <dt>Reasoning included</dt>
                      <dd className="text-right">{sample.reasoningTokens.toLocaleString()}</dd>
                    </>
                  ) : null}
                </dl>
                <p className="text-xs text-muted-foreground">
                  Real provider output counts divided by{" "}
                  {sample.timingSource === "provider"
                    ? "provider-reported API time"
                    : "observed model-request time"}
                  . Includes reasoning and tool-call generation as counted by the provider. Tool
                  execution is excluded. Request time includes latency and prompt processing; this
                  is not decode-only throughput.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {supported
                  ? props.provider === "commandcode"
                    ? "Available after a model response finishes. Command Code must report matching request boundaries and token usage."
                    : "Available after the turn finishes, when Claude reports complete usage and API duration for the same scope. Subagent runs are not currently measured."
                  : "This provider does not currently expose matching token counts and model-request timing through T3."}
              </p>
            )}
            {props.running ? (
              <p className="text-xs text-muted-foreground">
                {props.provider === "commandcode"
                  ? "Updates after each model response, not each text chunk."
                  : props.provider === "claudeAgent"
                    ? "Updates when the turn finishes."
                    : "No text-based token estimate is used."}
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
});
