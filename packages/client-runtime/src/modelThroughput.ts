import { ModelThroughputSample, type OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
const decodeSample = Schema.decodeUnknownOption(ModelThroughputSample);

export function latestModelThroughput(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: string | undefined,
) {
  if (!turnId) return null;
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!;
    if (activity.turnId !== turnId || activity.kind !== "model-throughput.updated") continue;
    const sample = decodeSample(activity.payload);
    if (sample._tag === "Some")
      return {
        ...sample.value,
        tokensPerSecond: (sample.value.outputTokens * 1000) / sample.value.durationMs,
      };
  }
  return null;
}

export function supportsModelThroughput(provider: string | undefined) {
  return provider === "commandcode" || provider === "claudeAgent";
}
