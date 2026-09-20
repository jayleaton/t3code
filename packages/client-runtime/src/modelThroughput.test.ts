import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { latestModelThroughput, supportsModelThroughput } from "./modelThroughput.ts";
const activity = (payload: unknown, turnId = "turn-1"): OrchestrationThreadActivity => ({
  id: EventId.make("throughput"),
  turnId: TurnId.make(turnId),
  kind: "model-throughput.updated",
  summary: "Model throughput",
  tone: "info",
  payload,
  createdAt: "2026-09-20T00:00:00Z",
});
const sample = {
  outputTokens: 500,
  reasoningTokens: 300,
  durationMs: 2000,
  scope: "response",
  timingSource: "observed",
};
describe("reported model throughput", () => {
  it("includes reported reasoning once, without using visible text or tool elapsed time", () => {
    expect(latestModelThroughput([activity(sample)], "turn-1")?.tokensPerSecond).toBe(250);
  });
  it("uses the latest valid measurement for this turn and never leaks a prior turn's rate", () => {
    const activities = [
      activity(sample),
      activity({ ...sample, outputTokens: 100 }),
      activity(sample, "turn-2"),
    ];
    expect(latestModelThroughput(activities, "turn-1")?.tokensPerSecond).toBe(50);
    expect(latestModelThroughput(activities, "turn-3")).toBeNull();
    expect(latestModelThroughput(activities, undefined)).toBeNull();
  });
  it.each([0, -1, Infinity, NaN])("rejects unusable request duration %s", (durationMs) => {
    expect(latestModelThroughput([activity({ ...sample, durationMs })], "turn-1")).toBeNull();
  });
  it("distinguishes a measured zero rate from missing telemetry", () => {
    expect(
      latestModelThroughput(
        [activity({ ...sample, outputTokens: 0, reasoningTokens: 0 })],
        "turn-1",
      )?.tokensPerSecond,
    ).toBe(0);
    expect(latestModelThroughput([], "turn-1")).toBeNull();
    expect(supportsModelThroughput("commandcode")).toBe(true);
    expect(supportsModelThroughput("claudeAgent")).toBe(true);
    expect(supportsModelThroughput("codex")).toBe(false);
  });
});
