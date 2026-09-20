import { memo, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  latestModelThroughput,
  supportsModelThroughput,
} from "@t3tools/client-runtime/model-throughput";
import { AppText as Text } from "../../components/AppText";
export const ThreadTpsPanel = memo(function ThreadTpsPanel(props: {
  turnId: string | undefined;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  provider: string | undefined;
  running: boolean;
  available: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
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
    <View className="px-4 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Tokens per second details"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="self-end py-2"
      >
        <Text className="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
          {label}
          {!props.available ? " · offline" : ""}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2 rounded-xl border border-border bg-card p-3">
          <Text className="text-sm font-medium">
            Tokens per second: {sample ? sample.tokensPerSecond.toFixed(1) : "—"}
          </Text>
          {sample ? (
            <>
              <Text className="text-xs">
                {sample.scope === "response"
                  ? "Last completed model response"
                  : "Completed turn API average"}
              </Text>
              <Text className="text-xs">
                {sample.outputTokens.toLocaleString()} output tokens /{" "}
                {(sample.durationMs / 1000).toFixed(2)}s API request time
              </Text>
              {sample.reasoningTokens !== undefined ? (
                <Text className="text-xs">
                  Reasoning included: {sample.reasoningTokens.toLocaleString()}
                </Text>
              ) : null}
              <Text className="text-xs text-muted-foreground">
                Real provider output counts divided by{" "}
                {sample.timingSource === "provider"
                  ? "provider-reported API time"
                  : "observed model-request time"}
                . Includes reasoning and tool-call generation as counted by the provider. Tool
                execution is excluded. Request time includes latency and prompt processing; this is
                not decode-only throughput.
              </Text>
            </>
          ) : (
            <Text className="text-xs text-muted-foreground">
              {supported
                ? props.provider === "commandcode"
                  ? "Available after a model response finishes, when Command Code reports matching request boundaries and usage."
                  : "Available after a turn with complete Claude usage and matching API duration. Subagent runs are not currently measured."
                : "This provider does not currently expose matching token counts and model-request timing through T3."}
            </Text>
          )}
          {props.running && supported ? (
            <Text className="text-xs text-muted-foreground">
              {props.provider === "commandcode"
                ? "Updates after each model response, not each text chunk."
                : "Updates when the turn finishes."}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});
