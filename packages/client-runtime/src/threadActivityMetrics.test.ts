import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { deriveThreadActivity, threadActivityLabel } from "./threadActivityMetrics.ts";
const timestamp = (s: number) => `2026-09-20T00:00:${String(s).padStart(2, "0")}.000Z`;
const at = (s: number) => Date.parse(timestamp(s));
const turn: OrchestrationLatestTurn = {
  turnId: TurnId.make("turn-1"),
  state: "running",
  requestedAt: timestamp(0),
  startedAt: timestamp(1),
  completedAt: null,
  assistantMessageId: null,
};
const message = (
  role: "assistant" | "reasoning",
  start: number,
  end: number,
  streaming = false,
): OrchestrationMessage => ({
  id: MessageId.make(`${role}-${start}`),
  turnId: turn.turnId,
  role,
  text: "text",
  createdAt: timestamp(start),
  updatedAt: timestamp(end),
  streaming,
});
const activity = (
  kind: string,
  second: number,
  payload: Record<string, unknown>,
  turnId: TurnId | null = turn.turnId,
): OrchestrationThreadActivity => ({
  id: EventId.make(`${kind}-${second}`),
  kind,
  createdAt: timestamp(second),
  payload,
  turnId,
  tone: "info",
  summary: "Run tests",
});
const tool = (kind: "started" | "completed", second: number, id = "tool-1") =>
  activity(`tool.${kind}`, second, { toolCallId: id, title: "Run tests" });

describe("whole-thread activity", () => {
  it("accounts for thinking, scripts, user waits, responses, and unreported work", () => {
    const result = deriveThreadActivity(
      {
        turn,
        messages: [
          message("reasoning", 1, 4),
          message("reasoning", 14, 17),
          message("assistant", 17, 20),
        ],
        activities: [
          tool("started", 4),
          activity("approval.requested", 6, { requestId: "approval-1" }),
          activity("approval.resolved", 9, { requestId: "approval-1" }),
          tool("completed", 14),
        ],
      },
      at(30),
    )!;
    expect(result.durations).toEqual({
      waiting: 3000,
      tools: 7000,
      thinking: 6000,
      responding: 3000,
      working: 11000,
    });
    expect(Object.values(result.durations).reduce((a, b) => a + b, 0)).toBe(result.elapsedMs);
    expect(result.currentPhase).toBe("working");
    expect(result.currentPhaseMs).toBe(10000);
    expect(result.finishedTools).toBe(1);
    expect(result.usage).toBeNull();
  });
  it("unions parallel tool spans and reports active script names without needing text", () => {
    const result = deriveThreadActivity(
      {
        turn,
        messages: [],
        activities: [tool("started", 2, "a"), tool("started", 4, "b"), tool("completed", 10, "a")],
      },
      at(14),
    )!;
    expect(result.durations.tools).toBe(12000);
    expect(result.currentPhase).toBe("tools");
    expect(result.currentPhaseMs).toBe(12000);
    expect(result.activeTools).toEqual([{ id: "b", title: "Run tests", elapsedMs: 10000 }]);
    expect(result.finishedTools).toBe(1);
    expect(result.totalTools).toBe(2);
    expect(threadActivityLabel(result)).toBe("Running tool");
  });
  it("shows real ongoing reasoning, and never guesses thinking for silent work", () => {
    const result = deriveThreadActivity(
      { turn, messages: [message("reasoning", 2, 2, true)], activities: [] },
      at(10),
    )!;
    expect(result.durations.thinking).toBe(8000);
    expect(result.currentPhase).toBe("thinking");
    expect(
      deriveThreadActivity({ turn, messages: [], activities: [] }, at(10))?.durations.working,
    ).toBe(10000);
  });
  it("resolves null-turn approval receipts and does not count nonblocking questions as waits", () => {
    const result = deriveThreadActivity(
      {
        turn,
        messages: [],
        activities: [
          activity("approval.resolved", 6, { requestId: "a" }, null),
          activity("approval.requested", 2, { requestId: "a" }),
          activity("user-input.requested", 7, { requestId: "q", responseMode: "message" }),
        ],
      },
      at(10),
    )!;
    expect(result.durations.waiting).toBe(4000);
    expect(result.currentPhase).toBe("working");
  });
  it("counts pending questions as waiting and gives them priority over open tools", () => {
    const result = deriveThreadActivity(
      {
        turn,
        messages: [],
        activities: [tool("started", 1), activity("user-input.requested", 3, { requestId: "q" })],
      },
      at(10),
    )!;
    expect(result.currentPhase).toBe("waiting");
    expect(result.durations.tools).toBe(2000);
    expect(result.durations.waiting).toBe(7000);
    expect(result.currentPhaseMs).toBe(7000);
  });
  it("freezes interrupted turns, clamps open spans, and does not invent missing tool start times", () => {
    const result = deriveThreadActivity(
      {
        turn: { ...turn, state: "interrupted", completedAt: timestamp(10) },
        messages: [message("reasoning", 1, 2, true)],
        activities: [tool("completed", 4, "unknown"), tool("started", 5, "open")],
      },
      at(30),
    )!;
    expect(result.elapsedMs).toBe(10000);
    expect(result.durations.tools).toBe(5000);
    expect(result.activeTools).toEqual([]);
    expect(threadActivityLabel(result)).toBe("Stopped");
  });
  it("retains provider-reported reasoning counts and marks partial main-agent totals", () => {
    const tokenUsage = {
      usageStatus: "partial",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 30,
    };
    const result = deriveThreadActivity(
      { turn, messages: [], activities: [activity("turn.usage", 10, { tokenUsage })] },
      at(10),
    )!;
    expect(result.usage).toEqual(tokenUsage);
  });
  it("ignores invalid usage, other turns, and events outside the turn", () => {
    const result = deriveThreadActivity(
      {
        turn: { ...turn, state: "completed", completedAt: timestamp(10) },
        messages: [],
        activities: [
          tool("started", 20),
          activity("tool.started", 2, { toolCallId: "other" }, TurnId.make("turn-2")),
          activity("turn.usage", 5, { tokenUsage: { outputTokens: -5 } }),
        ],
      },
      at(30),
    )!;
    expect(result.totalTools).toBe(0);
    expect(result.usage).toBeNull();
    expect(result.durations.working).toBe(10000);
    expect(deriveThreadActivity({ turn: null, messages: [], activities: [] }, at(10))).toBeNull();
  });
  it("keeps terminal tool updates from leaving a thread stuck running a command", () => {
    const result = deriveThreadActivity(
      {
        turn,
        messages: [],
        activities: [
          tool("started", 1),
          activity("tool.updated", 5, { toolCallId: "tool-1", status: "failed" }),
        ],
      },
      at(10),
    )!;
    expect(result.failedTools).toBe(1);
    expect(result.finishedTools).toBe(1);
    expect(result.currentPhase).toBe("working");
  });
});
