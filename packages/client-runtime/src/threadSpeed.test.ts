import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { createThreadSpeedTracker } from "./threadSpeed.ts";
const epoch = Date.parse("2026-09-20T00:00:00Z");
const turn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-1"),
  state: "running",
  requestedAt: "2026-09-20T00:00:00.000Z",
  startedAt: "2026-09-20T00:00:00.500Z",
  completedAt: null,
  assistantMessageId: null,
};
const message = (
  length: number,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage => ({
  id: MessageId.make("message-1"),
  turnId: turn.turnId,
  role: "assistant",
  text: "a".repeat(length),
  streaming: true,
  createdAt: "2026-09-20T00:00:01.500Z",
  updatedAt: "2026-09-20T00:00:02.000Z",
  ...overrides,
});

describe("thread speed", () => {
  it("measures new visible text without counting existing history as a burst", () => {
    const tracker = createThreadSpeedTracker();
    expect(
      tracker.sample({ turn, messages: [message(4000)] }, 0, epoch)?.tokensPerSecond,
    ).toBeNull();
    const next = tracker.sample({ turn, messages: [message(4400)] }, 1000, epoch + 1000);
    expect(next?.tokensPerSecond).toBe(100);
    expect(next?.estimatedOutputTokens).toBe(1100);
    expect(next?.firstOutputMs).toBe(1500);
  });
  it("drops stale output after the rolling window, including tool waits", () => {
    const tracker = createThreadSpeedTracker();
    tracker.sample({ turn, messages: [] }, 0, epoch);
    for (let second = 1; second <= 6; second++) {
      const result = tracker.sample(
        { turn, messages: [message(400)] },
        second * 1000,
        epoch + second * 1000,
      );
      if (second === 1) expect(result?.tokensPerSecond).toBe(100);
      if (second === 6) expect(result?.tokensPerSecond).toBe(0);
    }
  });
  it("resets on missed samples, text replacement, clock reset, and new turns", () => {
    const tracker = createThreadSpeedTracker();
    const sample = (at: number, length: number, current = turn) =>
      tracker.sample({ turn: current, messages: [message(length)] }, at, epoch + at);
    sample(0, 0);
    expect(sample(1000, 400)?.tokensPerSecond).toBe(100);
    expect(sample(10_000, 4000)?.tokensPerSecond).toBeNull();
    expect(sample(11_000, 20)?.tokensPerSecond).toBeNull();
    expect(sample(5, 400)?.tokensPerSecond).toBeNull();
    expect(
      sample(1005, 400, { ...turn, turnId: TurnId.make("turn-2") })?.tokensPerSecond,
    ).toBeNull();
    tracker.reset();
    expect(sample(2005, 800)?.tokensPerSecond).toBeNull();
  });
  it("excludes user messages, reasoning, and previous turns", () => {
    const tracker = createThreadSpeedTracker();
    const result = tracker.sample(
      {
        turn,
        messages: [
          message(400),
          message(2000, { role: "user" }),
          message(1000, { role: "reasoning" }),
          message(3000, { turnId: TurnId.make("older") }),
        ],
      },
      0,
      epoch,
    );
    expect(result?.estimatedOutputTokens).toBe(100);
  });
  it("uses the full elapsed turn for the completed average and freezes it", () => {
    const tracker = createThreadSpeedTracker();
    const completed = {
      ...turn,
      state: "completed" as const,
      completedAt: "2026-09-20T00:00:10.000Z",
    };
    const result = tracker.sample(
      { turn: completed, messages: [message(4000)] },
      20000,
      epoch + 99999,
    );
    expect(result?.tokensPerSecond).toBe(100);
    expect(result?.elapsedMs).toBe(10_000);
    expect(result?.running).toBe(false);
  });
  it("does not count loaded history as new output while a turn is running", () => {
    const tracker = createThreadSpeedTracker();
    tracker.sample({ turn, messages: [message(400)] }, 0, epoch);
    expect(
      tracker.sample(
        {
          turn,
          messages: [
            message(800),
            message(4000, { id: MessageId.make("restored"), streaming: false }),
          ],
        },
        1000,
        epoch + 1000,
      )?.tokensPerSecond,
    ).toBeNull();
  });
  it("handles missing turns, no output, and invalid durations", () => {
    const tracker = createThreadSpeedTracker();
    expect(tracker.sample({ turn: null, messages: [] }, 0, epoch)).toBeNull();
    const result = tracker.sample(
      { turn: { ...turn, state: "interrupted", completedAt: turn.requestedAt }, messages: [] },
      1000,
      epoch,
    );
    expect(result?.tokensPerSecond).toBeNull();
    expect(result?.firstOutputMs).toBeNull();
    expect(result?.estimatedOutputTokens).toBe(0);
  });
});
