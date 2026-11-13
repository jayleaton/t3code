import {
  SCHEDULED_TASK_ARCHIVE_AFTER_DAYS,
  SCHEDULED_TASK_UNUSED_WEBHOOK_ARCHIVE_AFTER_DAYS,
  type ScheduledTask,
} from "@t3tools/contracts";

export type ScheduledTaskView = "active" | "archived";

export function isScheduledTaskArchived(task: Pick<ScheduledTask, "archivedAt">): boolean {
  return task.archivedAt != null;
}

export function scheduledTasksInView<T extends Pick<ScheduledTask, "archivedAt">>(
  tasks: ReadonlyArray<T>,
  view: ScheduledTaskView,
): T[] {
  return tasks.filter((task) => isScheduledTaskArchived(task) === (view === "archived"));
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
