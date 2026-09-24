import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * A prompt the environment sends to an agent at a set time or on a cron
 * schedule. Every run of a task lands in the same thread, created on the first
 * run from the task's agent profile. The server owns the clock: tasks only run
 * while the environment's server is up, and a run missed while it was down
 * fires once as soon as it is back.
 */
export const ScheduledTaskId = TrimmedNonEmptyString.pipe(Schema.brand("ScheduledTaskId"));
export type ScheduledTaskId = typeof ScheduledTaskId.Type;

export const SCHEDULED_TASK_TITLE_MAX_LENGTH = 120;
export const SCHEDULED_TASK_PROMPT_MAX_LENGTH = 20_000;
export const SCHEDULED_TASK_ERROR_MAX_LENGTH = 1_000;

export const ScheduledTaskTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SCHEDULED_TASK_TITLE_MAX_LENGTH),
);
export const ScheduledTaskPrompt = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SCHEDULED_TASK_PROMPT_MAX_LENGTH),
);

export const ScheduledTaskSchedule = Schema.Union([
  /** Runs once at runAt, then disables itself. */
  Schema.Struct({ kind: Schema.Literal("once"), runAt: IsoDateTime }),
  /** Five-field cron (minute hour day-of-month month weekday) evaluated in an IANA time zone. */
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: TrimmedNonEmptyString,
    timezone: TrimmedNonEmptyString,
  }),
]);
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

export const ScheduledTaskRunStatus = Schema.Literals(["sent", "failed"]);
export type ScheduledTaskRunStatus = typeof ScheduledTaskRunStatus.Type;

export const ScheduledTask = Schema.Struct({
  taskId: ScheduledTaskId,
  title: ScheduledTaskTitle,
  prompt: ScheduledTaskPrompt,
  profileId: TrimmedNonEmptyString,
  projectId: ProjectId,
  /** The thread every run posts to; null until the first run creates it. */
  threadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  enabled: Schema.Boolean,
  /** Null when disabled or when a one-time task has already run. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: Schema.NullOr(ScheduledTaskRunStatus),
  lastRunError: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(SCHEDULED_TASK_ERROR_MAX_LENGTH)),
  ),
  runCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskCreateInput = Schema.Struct({
  /** Defaults to the first line of the prompt. */
  title: Schema.optional(ScheduledTaskTitle),
  prompt: ScheduledTaskPrompt,
  profileId: TrimmedNonEmptyString,
  projectId: ProjectId,
  schedule: ScheduledTaskSchedule,
  enabled: Schema.optional(Schema.Boolean),
});
export type ScheduledTaskCreateInput = typeof ScheduledTaskCreateInput.Type;

/**
 * Changing the agent or project detaches the current thread; the next run
 * starts a new one. Re-enabling or rescheduling a finished one-time task arms it again.
 */
export const ScheduledTaskUpdateInput = Schema.Struct({
  taskId: ScheduledTaskId,
  patch: Schema.Struct({
    title: Schema.optional(ScheduledTaskTitle),
    prompt: Schema.optional(ScheduledTaskPrompt),
    profileId: Schema.optional(TrimmedNonEmptyString),
    projectId: Schema.optional(ProjectId),
    schedule: Schema.optional(ScheduledTaskSchedule),
    enabled: Schema.optional(Schema.Boolean),
  }),
});
export type ScheduledTaskUpdateInput = typeof ScheduledTaskUpdateInput.Type;

export const ScheduledTaskTarget = Schema.Struct({ taskId: ScheduledTaskId });
export type ScheduledTaskTarget = typeof ScheduledTaskTarget.Type;

export const ScheduledTaskListResult = Schema.Struct({ tasks: Schema.Array(ScheduledTask) });
export type ScheduledTaskListResult = typeof ScheduledTaskListResult.Type;

export const ScheduledTaskSubscribeInput = Schema.Struct({});
export type ScheduledTaskSubscribeInput = typeof ScheduledTaskSubscribeInput.Type;

/** Every task on the environment. Sent first, then after every change. */
export const ScheduledTaskListEvent = Schema.Array(ScheduledTask);
export type ScheduledTaskListEvent = typeof ScheduledTaskListEvent.Type;

export class ScheduledTaskError extends Schema.TaggedError<ScheduledTaskError>()(
  "ScheduledTaskError",
  { message: Schema.String },
) {}
