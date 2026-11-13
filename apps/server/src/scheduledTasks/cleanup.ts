import {
  SCHEDULED_TASK_ARCHIVE_AFTER_DAYS,
  SCHEDULED_TASK_ARCHIVE_RETENTION_DAYS,
  SCHEDULED_TASK_UNUSED_WEBHOOK_ARCHIVE_AFTER_DAYS,
  type ScheduledTask,
} from "@t3tools/contracts";

const DAY_MS = 86_400_000;
const FAILURES_BEFORE_ARCHIVE = 3;

export interface CleanupCandidate extends Pick<
  ScheduledTask,
  | "enabled"
  | "runCount"
  | "createdAt"
  | "updatedAt"
  | "lastRunAt"
  | "nextRunAt"
  | "lastRunStatus"
  | "threadId"
  | "profileId"
> {
  readonly schedule: { readonly type: ScheduledTask["schedule"]["type"] };
  readonly archivedAt: string | null;
  readonly failingSince: string | null;
  readonly consecutiveFailures: number;
}

export interface CleanupContext {
  readonly nowMs: number;
  /** Whether this process is dispatching the task right now. */
  readonly running: boolean;
  /** When the bound thread was archived, for a task bound to an archived thread. */
  readonly threadArchivedAt: string | null;
  /** The newest logged webhook delivery of any outcome. */
  readonly latestDeliveryAt: string | null;
}

export type CleanupDecision =
  | { readonly _tag: "keep" }
  | { readonly _tag: "delete" }
  | {
      readonly _tag: "archive";
      readonly reason: "completed" | "paused" | "failing" | "thread_archived" | "webhook_unused";
    };

const KEEP: CleanupDecision = { _tag: "keep" };

const millis = (value: string | null | undefined) => {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Archives stale tasks, and deletes archived ones once their retention window has passed. */
export function cleanupDecision(task: CleanupCandidate, context: CleanupContext): CleanupDecision {
  if (context.running || task.lastRunStatus === "running") return KEEP;
  const { nowMs } = context;
  const olderThan = (at: number | null, days: number) => at !== null && at <= nowMs - days * DAY_MS;

  if (task.archivedAt !== null) {
    return olderThan(millis(task.archivedAt), SCHEDULED_TASK_ARCHIVE_RETENTION_DAYS)
      ? { _tag: "delete" }
      : KEEP;
  }
  const failing = task.consecutiveFailures > 0;
  const nextRunAt = millis(task.nextRunAt);
  if (task.enabled && nextRunAt !== null && nextRunAt > nowMs && !failing) return KEEP;

  // An agent task launches a new thread when its thread is archived, so only other tasks follow.
  if (
    task.profileId === undefined &&
    task.threadId !== null &&
    olderThan(millis(context.threadArchivedAt), SCHEDULED_TASK_ARCHIVE_AFTER_DAYS)
  ) {
    return { _tag: "archive", reason: "thread_archived" };
  }
  if (
    task.consecutiveFailures >= FAILURES_BEFORE_ARCHIVE &&
    olderThan(millis(task.failingSince), SCHEDULED_TASK_ARCHIVE_AFTER_DAYS)
  ) {
    return { _tag: "archive", reason: "failing" };
  }
  if (task.schedule.type === "webhook" && task.runCount === 0) {
    // Quiet is normal for an event trigger, so only one that never fired is stale.
    const lastTouched = Math.max(
      ...[task.createdAt, task.updatedAt, context.latestDeliveryAt].flatMap(
        (value) => millis(value) ?? [],
      ),
    );
    return olderThan(lastTouched, SCHEDULED_TASK_UNUSED_WEBHOOK_ARCHIVE_AFTER_DAYS)
      ? { _tag: "archive", reason: "webhook_unused" }
      : KEEP;
  }
  if (task.enabled) return KEEP;
  if (task.schedule.type === "once" && task.runCount > 0) {
    return olderThan(millis(task.lastRunAt), SCHEDULED_TASK_ARCHIVE_AFTER_DAYS)
      ? { _tag: "archive", reason: "completed" }
      : KEEP;
  }
  return olderThan(millis(task.updatedAt), SCHEDULED_TASK_ARCHIVE_AFTER_DAYS)
    ? { _tag: "archive", reason: "paused" }
    : KEEP;
}
