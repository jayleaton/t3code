import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { threadShellHasActiveWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";
import type * as ProjectionStore from "./ProjectionStore.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function latestMillis(values: ReadonlyArray<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/**
 * A recent user message stays queued until a run adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. A failed run start
 * clears the block immediately (mirrors the v1 session "error" rule).
 */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

/** Reject busy and explicitly parked cards before applying their idle period. */
export function isAutoSettlementCandidate(
  thread: Omit<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride === "settled") return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  // Blocked-on-you work must never park behind a settled override.
  if (thread.pendingRuntimeRequest !== null) return false;
  // A live run, or background work that will wake the agent, is not
  // staleness. A dev server left running is: the agent is done.
  if (threadShellHasActiveWork(thread)) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return true;
  // A snoozed thread that woke early (error or completed work) can settle;
  // one still parked on its wake time keeps its stronger statement.
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  const wokeOnCompletion =
    snoozedAtMs !== null && completedAtMs !== null && completedAtMs > snoozedAtMs;
  return wokeOnError || wokeOnCompletion;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: ProjectionStore.ProjectionSettlementCandidate;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
}): DateTime.Utc | null {
  const { thread } = input;
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  if (input.autoSettleAfterDays === null || input.autoSettleAfterDays <= 0) return null;
  const activityAtMs = latestMillis([
    toMillis(thread.createdAt),
    toMillis(thread.updatedAt),
    toMillis(thread.unsettledAt),
    toMillis(thread.lastVisitedAt),
    toMillis(thread.latestBackgroundActivityAt),
    toMillis(thread.latestUserMessageAt),
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ]);
  return activityAtMs !== null && activityAtMs <= input.nowMs - input.autoSettleAfterDays * DAY_MS
    ? DateTime.makeUnsafe(activityAtMs)
    : null;
}
