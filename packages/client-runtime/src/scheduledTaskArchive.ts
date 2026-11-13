import {
  SCHEDULED_TASK_ARCHIVE_AFTER_DAYS,
  SCHEDULED_TASK_UNUSED_WEBHOOK_ARCHIVE_AFTER_DAYS,
  scheduledTaskTarget,
  type ScheduledTask,
  type ScheduledTaskTarget,
} from "@t3tools/contracts";

export function isScheduledTaskArchived(task: Pick<ScheduledTask, "archivedAt">): boolean {
  return task.archivedAt != null;
}

export type ScheduledTaskFilter = "all" | ScheduledTaskTarget | "archived";

export const SCHEDULED_TASK_FILTERS: ReadonlyArray<{
  readonly value: ScheduledTaskFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "agent", label: "Agents" },
  { value: "thread", label: "Threads" },
  { value: "new_thread", label: "New thread" },
  { value: "archived", label: "Archived" },
];

/** Archived tasks show only under Archived; the other filters split the rest by target. */
export function scheduledTaskMatchesFilter(
  task: Pick<ScheduledTask, "archivedAt" | "profileId" | "threadId" | "threadMode">,
  filter: ScheduledTaskFilter,
): boolean {
  if (filter === "archived") return isScheduledTaskArchived(task);
  if (isScheduledTaskArchived(task)) return false;
  return filter === "all" || scheduledTaskTarget(task) === filter;
}

const ARCHIVE_REASON_LABELS: Record<string, string> = {
  completed: "Archived: finished its one-time run",
  paused: `Archived: paused for ${SCHEDULED_TASK_ARCHIVE_AFTER_DAYS} days`,
  failing: `Archived: failing for ${SCHEDULED_TASK_ARCHIVE_AFTER_DAYS} days`,
  thread_archived: "Archived: its thread was archived",
  webhook_unused: `Archived: never triggered in ${SCHEDULED_TASK_UNUSED_WEBHOOK_ARCHIVE_AFTER_DAYS} days`,
};

export function scheduledTaskArchiveLabel(task: Pick<ScheduledTask, "archiveReason">): string {
  return (task.archiveReason && ARCHIVE_REASON_LABELS[task.archiveReason]) || "Archived";
}

/** A one-time task whose run time passed can't be re-enabled; the editor asks for a new time. */
export function scheduledTaskRestoreNeedsEditor(
  task: Pick<ScheduledTask, "schedule">,
  nowMs: number,
): boolean {
  return task.schedule.type === "once" && !(Date.parse(task.schedule.runAt) > nowMs);
}
