import { describe, expect, it } from "@effect/vitest";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

import { decidePush, type PushKind } from "./pushPolicy.ts";

const NOW = 1_000_000_000;
const seen = (phase: AgentAwarenessPhase | null, requestId: string | null = null, ageMs = 0) => ({
  phase,
  requestId,
  updatedAtMs: NOW - ageMs,
});
const topLevel = { topLevel: true, snoozed: false };
const child = { topLevel: false, snoozed: false };
const snoozed = { topLevel: true, snoozed: true };

describe("decidePush", () => {
  it.each<
    [
      string,
      ReturnType<typeof seen> | undefined,
      ReturnType<typeof seen>,
      typeof topLevel,
      PushKind | null,
    ]
  >([
    ["is silent on the first sighting", undefined, seen("waiting_for_input", "r1"), topLevel, null],
    ["announces a question", seen("running"), seen("waiting_for_input", "r1"), topLevel, "input"],
    [
      "announces an approval",
      seen("running"),
      seen("waiting_for_approval", "r1"),
      topLevel,
      "approval",
    ],
    [
      "repeats nothing for the same wait",
      seen("waiting_for_approval", "r1"),
      seen("waiting_for_approval", "r1"),
      topLevel,
      null,
    ],
    [
      "announces the next wait",
      seen("waiting_for_approval", "r1"),
      seen("waiting_for_approval", "r2"),
      topLevel,
      "approval",
    ],
    [
      "asks from a child (sent as its top-level thread)",
      seen("running"),
      seen("waiting_for_input", "r1"),
      child,
      "input",
    ],
    ["asks while snoozed", seen("running"), seen("waiting_for_input", "r1"), snoozed, "input"],
    ["announces a finish", seen("running"), seen("completed"), topLevel, "completed"],
    ["announces a failure", seen("running"), seen("failed"), topLevel, "failed"],
    ["keeps a child's finish quiet", seen("running"), seen("completed"), child, null],
    ["keeps a child's failure quiet", seen("running"), seen("failed"), child, null],
    ["keeps a finish quiet while snoozed", seen("running"), seen("completed"), snoozed, null],
    ["lets a failure through a snooze", seen("running"), seen("failed"), snoozed, "failed"],
    ["repeats nothing for the same result", seen("completed"), seen("failed"), topLevel, null],
    [
      "ignores a stale result",
      seen("running"),
      seen("completed", null, 3 * 60_000),
      topLevel,
      null,
    ],
    ["stays quiet when a settled result hides", seen("completed"), seen(null), topLevel, null],
    ["stays quiet while running", seen(null), seen("running"), topLevel, null],
  ])("%s", (_name, previous, next, facts, expected) => {
    expect(decidePush({ previous, next, facts, nowMs: NOW })).toBe(expected);
  });
});
