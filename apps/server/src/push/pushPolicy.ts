import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";

export type PushKind = "input" | "approval" | "completed" | "failed";

/** What the notifier last saw of one thread. */
export interface PushObservation {
  readonly phase: AgentAwarenessPhase | null;
  /** The pending request behind an attention phase; a new id is a new wait. */
  readonly requestId: string | null;
  readonly updatedAtMs: number;
}

export interface PushThreadFacts {
  /** No parent of any kind. Only these report results; a child's questions go out as its top-level thread's. */
  readonly topLevel: boolean;
  readonly snoozed: boolean;
}

// A result older than this is a replay of old state, not news.
const TERMINAL_FRESHNESS_MS = 2 * 60 * 1_000;

const attentionKind = (phase: AgentAwarenessPhase | null): PushKind | null =>
  phase === "waiting_for_input" ? "input" : phase === "waiting_for_approval" ? "approval" : null;

const isTerminal = (phase: AgentAwarenessPhase | null) =>
  phase === "completed" || phase === "failed";

export function decidePush(input: {
  readonly previous: PushObservation | undefined;
  readonly next: PushObservation;
  readonly facts: PushThreadFacts;
  readonly nowMs: number;
}): PushKind | null {
  const { previous, next, facts } = input;
  // The first sighting after a restart is a baseline, not a transition.
  if (previous === undefined) return null;
  const attention = attentionKind(next.phase);
  if (attention !== null) {
    return attentionKind(previous.phase) !== null && previous.requestId === next.requestId
      ? null
      : attention;
  }
  if (!isTerminal(next.phase) || isTerminal(previous.phase) || !facts.topLevel) return null;
  // A snooze hides results, but a failure still ends it.
  if (next.phase === "completed" && facts.snoozed) return null;
  if (input.nowMs - next.updatedAtMs > TERMINAL_FRESHNESS_MS) return null;
  return next.phase === "completed" ? "completed" : "failed";
}
