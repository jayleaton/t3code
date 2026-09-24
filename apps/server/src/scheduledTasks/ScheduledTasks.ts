import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  SCHEDULED_TASK_ERROR_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  type ScheduledTaskUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { resolveThreadCreateProfile } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  isoFromMs,
  nextRunAt,
  normalizeSchedule,
  parseIsoMs,
  scheduleProblem,
} from "./schedule.ts";

/**
 * The loop re-reads the table at least this often, so a missed timer (the
 * host slept, the wall clock jumped) delays a run by at most this much.
 */
const MAX_IDLE_MS = 60_000;
/** A one-time schedule may be armed this far in the past, so "now" from a slow client still counts. */
const ONCE_PAST_TOLERANCE_MS = 60_000;

export class ScheduledTasks extends Context.Service<
  ScheduledTasks,
  {
    readonly list: Effect.Effect<ReadonlyArray<ScheduledTask>, ScheduledTaskError>;
    readonly create: (
      input: ScheduledTaskCreateInput,
    ) => Effect.Effect<ScheduledTask, ScheduledTaskError>;
    readonly update: (
      input: ScheduledTaskUpdateInput,
    ) => Effect.Effect<ScheduledTask, ScheduledTaskError>;
    readonly remove: (taskId: ScheduledTaskId) => Effect.Effect<void, ScheduledTaskError>;
    /** Sends the prompt now without moving the schedule. */
    readonly runNow: (taskId: ScheduledTaskId) => Effect.Effect<ScheduledTask, ScheduledTaskError>;
    /** Every task, first on subscribe and then after each change. */
    readonly stream: Stream.Stream<ReadonlyArray<ScheduledTask>>;
    /** Fires every task that is due now. The loop started by `start` calls this. */
    readonly runDue: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/scheduledTasks/ScheduledTasks") {}

const TaskRow = Schema.Struct({
  taskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  profileId: Schema.String,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  schedule: Schema.fromJsonString(ScheduledTaskSchedule),
  enabled: Schema.Int,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastRunStatus: Schema.NullOr(ScheduledTaskRunStatus),
  lastRunError: Schema.NullOr(Schema.String),
  runCount: Schema.Int,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const fromRow = (row: typeof TaskRow.Type): ScheduledTask => ({
  ...row,
  enabled: row.enabled === 1,
});

const toRow = (task: ScheduledTask): typeof TaskRow.Encoded => ({
  ...task,
  schedule: JSON.stringify(task.schedule),
  enabled: task.enabled ? 1 : 0,
});

const errorMessage = (cause: unknown): string => {
  const message =
    typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : String(cause);
  return message.slice(0, SCHEDULED_TASK_ERROR_MAX_LENGTH);
};

const fail = (message: string) => new ScheduledTaskError({ message });

export function defaultTaskTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0]!.trim();
  return firstLine.length <= SCHEDULED_TASK_TITLE_MAX_LENGTH
    ? firstLine
    : `${firstLine.slice(0, SCHEDULED_TASK_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;

  const changes = yield* PubSub.unbounded<ReadonlyArray<ScheduledTask>>();
  const wake = yield* Queue.sliding<void>(1);
  // Mutations and runs take turns, so a run never overwrites an edit made while it was sending.
  const lock = yield* Semaphore.make(1);

  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowMs = Clock.currentTimeMillis;
  const nowIso = Effect.map(nowMs, (ms) => isoFromMs(ms));
  const sqlError = (cause: unknown) =>
    fail(`Scheduled task storage failed: ${errorMessage(cause)}`);

  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskRow,
    execute: () => sql`
      SELECT task_id AS "taskId", title, prompt, profile_id AS "profileId",
        project_id AS "projectId", thread_id AS "threadId", schedule_json AS "schedule",
        enabled, next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
        last_run_status AS "lastRunStatus", last_run_error AS "lastRunError",
        run_count AS "runCount", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM scheduled_tasks
      ORDER BY created_at, task_id
    `,
  });

  const list = selectAll(undefined).pipe(
    Effect.map((rows) => rows.map(fromRow)),
    Effect.mapError(sqlError),
  );

  const find = (taskId: ScheduledTaskId) =>
    list.pipe(
      Effect.map((tasks) => tasks.find((task) => task.taskId === taskId)),
      Effect.filterOrFail(
        (task) => task !== undefined,
        () => fail(`Scheduled task ${taskId} was not found.`),
      ),
    );

  const save = (task: ScheduledTask) => {
    const row = toRow(task);
    return sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, profile_id, project_id, thread_id, schedule_json, enabled,
        next_run_at, last_run_at, last_run_status, last_run_error, run_count, created_at, updated_at
      ) VALUES (
        ${row.taskId}, ${row.title}, ${row.prompt}, ${row.profileId}, ${row.projectId},
        ${row.threadId}, ${row.schedule}, ${row.enabled}, ${row.nextRunAt}, ${row.lastRunAt},
        ${row.lastRunStatus}, ${row.lastRunError}, ${row.runCount}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        title = excluded.title, prompt = excluded.prompt, profile_id = excluded.profile_id,
        project_id = excluded.project_id, thread_id = excluded.thread_id,
        schedule_json = excluded.schedule_json, enabled = excluded.enabled,
        next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at,
        last_run_status = excluded.last_run_status, last_run_error = excluded.last_run_error,
        run_count = excluded.run_count, updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(sqlError));
  };

  const publish = list.pipe(
    Effect.flatMap((tasks) => PubSub.publish(changes, tasks)),
    Effect.andThen(Queue.offer(wake, undefined)),
    Effect.catch((error) => Effect.logWarning("scheduled-tasks.publish-failed", { error })),
    Effect.asVoid,
  );

  const loadProfile = Effect.fn("ScheduledTasks.loadProfile")(function* (profileId: string) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError((error) => fail(`Server settings are unavailable: ${errorMessage(error)}`)),
    );
    const profile = settings.mcpGatewayProfiles.find((item) => item.profileId === profileId);
    if (profile === undefined) {
      return yield* fail(`Agent ${profileId} does not exist on this environment.`);
    }
    if (profile.runtimeMode === "read-only") {
      return yield* fail(`Agent "${profile.name}" is read-only and cannot run scheduled tasks.`);
    }
    return { settings, profile, runtimeMode: profile.runtimeMode };
  });

  const requireProject = (projectId: ProjectId) =>
    projection.getProjectShellById(projectId).pipe(
      Effect.mapError(sqlError),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(fail(`Project ${projectId} does not exist on this environment.`)),
          onSome: (project) => Effect.succeed(project),
        }),
      ),
    );

  /** Validates a schedule that is about to be armed and returns its first run. */
  const armedNextRun = Effect.fn("ScheduledTasks.armedNextRun")(function* (
    schedule: ScheduledTaskSchedule,
  ) {
    const problem = scheduleProblem(schedule);
    if (problem !== null) return yield* fail(problem);
    const now = yield* nowMs;
    if (
      schedule.kind === "once" &&
      (parseIsoMs(schedule.runAt) ?? 0) < now - ONCE_PAST_TOLERANCE_MS
    ) {
      return yield* fail(`runAt ${schedule.runAt} is in the past. Pick a future time.`);
    }
    return nextRunAt(schedule, now);
  });

  const create: ScheduledTasks["Service"]["create"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* loadProfile(input.profileId);
          yield* requireProject(input.projectId);
          const enabled = input.enabled ?? true;
          const problem = scheduleProblem(input.schedule);
          if (problem !== null) return yield* fail(problem);
          const now = yield* nowIso;
          const task: ScheduledTask = {
            taskId: ScheduledTaskId.make(yield* newId),
            title: input.title ?? defaultTaskTitle(input.prompt),
            prompt: input.prompt,
            profileId: input.profileId,
            projectId: input.projectId,
            threadId: null,
            schedule: normalizeSchedule(input.schedule),
            enabled,
            nextRunAt: enabled ? yield* armedNextRun(input.schedule) : null,
            lastRunAt: null,
            lastRunStatus: null,
            lastRunError: null,
            runCount: 0,
            createdAt: now,
            updatedAt: now,
          };
          yield* save(task);
          return task;
        }),
      )
      .pipe(Effect.tap(() => publish));

  const update: ScheduledTasks["Service"]["update"] = ({ taskId, patch }) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* find(taskId);
          const profileId = patch.profileId ?? existing.profileId;
          const projectId = patch.projectId ?? existing.projectId;
          if (patch.profileId !== undefined) yield* loadProfile(profileId);
          if (patch.projectId !== undefined) yield* requireProject(projectId);
          if (patch.schedule !== undefined) {
            const problem = scheduleProblem(patch.schedule);
            if (problem !== null) return yield* fail(problem);
          }
          const schedule =
            patch.schedule === undefined ? existing.schedule : normalizeSchedule(patch.schedule);
          const enabled = patch.enabled ?? existing.enabled;
          const rearm = patch.schedule !== undefined || patch.enabled !== undefined;
          const next = !enabled ? null : rearm ? yield* armedNextRun(schedule) : existing.nextRunAt;
          const task: ScheduledTask = {
            ...existing,
            title: patch.title ?? existing.title,
            prompt: patch.prompt ?? existing.prompt,
            profileId,
            projectId,
            // A different agent or project cannot keep posting into the old thread.
            threadId:
              profileId === existing.profileId && projectId === existing.projectId
                ? existing.threadId
                : null,
            schedule,
            enabled,
            nextRunAt: next,
            updatedAt: yield* nowIso,
          };
          yield* save(task);
          return task;
        }),
      )
      .pipe(Effect.tap(() => publish));

  const remove: ScheduledTasks["Service"]["remove"] = (taskId) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* find(taskId);
          yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${taskId}`.pipe(
            Effect.mapError(sqlError),
          );
        }),
      )
      .pipe(Effect.tap(() => publish));

  /** Returns the task's thread, creating it from the agent profile when it is missing. */
  const ensureThread = Effect.fn("ScheduledTasks.ensureThread")(function* (task: ScheduledTask) {
    if (task.threadId !== null) {
      const shell = yield* projection
        .getThreadShellById(task.threadId)
        .pipe(Effect.mapError(sqlError));
      if (Option.isSome(shell) && shell.value.archivedAt === null) {
        return {
          threadId: task.threadId,
          runtimeMode: shell.value.runtimeMode,
          interactionMode: shell.value.interactionMode,
        };
      }
    }
    const [{ settings, profile, runtimeMode }, providers] = yield* Effect.all([
      loadProfile(task.profileId),
      providerRegistry.getProviders,
    ]);
    yield* requireProject(task.projectId);
    const threadId = ThreadId.make(yield* newId);
    const createdAt = yield* nowIso;
    const command = yield* Effect.try({
      try: () =>
        resolveThreadCreateProfile(
          {
            type: "thread.create" as const,
            commandId: CommandId.make(`server:scheduled-task:${task.taskId}:${threadId}`),
            threadId,
            projectId: task.projectId,
            title: task.title,
            branch: null,
            worktreePath: null,
            createdAt,
            profileSelection: {
              profileId: profile.profileId,
              revision: profile.revision,
              overrideFields: [],
            },
          },
          settings,
          providers,
        ),
      catch: (cause) => fail(errorMessage(cause)),
    });
    yield* engine
      .dispatch(command as OrchestrationCommand)
      .pipe(
        Effect.mapError((error) => fail(`Could not create the thread: ${errorMessage(error)}`)),
      );
    return {
      threadId,
      runtimeMode,
      interactionMode: profile.interactionMode,
    };
  });

  /**
   * Sends one run and records the outcome. Scheduled runs move the schedule
   * forward before sending, so a crash mid-send skips a run rather than
   * repeating it; missed occurrences collapse into this one run.
   */
  const fire = Effect.fn("ScheduledTasks.fire")(function* (
    task: ScheduledTask,
    mode: "scheduled" | "manual",
  ) {
    const now = yield* nowMs;
    let current = task;
    if (mode === "scheduled") {
      current = {
        ...task,
        enabled: task.schedule.kind === "cron",
        nextRunAt: task.schedule.kind === "cron" ? nextRunAt(task.schedule, now) : null,
        updatedAt: isoFromMs(now),
      };
      yield* save(current);
    }
    const outcome = yield* Effect.gen(function* () {
      const thread = yield* ensureThread(current);
      // Threads are ready for a turn once created, so this is recorded even if the send fails.
      current = { ...current, threadId: thread.threadId };
      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:scheduled-task:${task.taskId}:${yield* newId}`),
          threadId: thread.threadId,
          message: {
            messageId: MessageId.make(yield* newId),
            role: "user",
            text: current.prompt,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: isoFromMs(now),
        })
        .pipe(
          Effect.mapError((error) => fail(`Could not send the prompt: ${errorMessage(error)}`)),
        );
    }).pipe(
      Effect.as({ status: "sent" as const, error: null }),
      Effect.catchCause((cause) =>
        Effect.succeed({ status: "failed" as const, error: errorMessage(cause) }),
      ),
    );
    if (outcome.status === "failed") {
      yield* Effect.logWarning("scheduled-tasks.run-failed", {
        taskId: task.taskId,
        error: outcome.error,
      });
    }
    const finished: ScheduledTask = {
      ...current,
      lastRunAt: isoFromMs(now),
      lastRunStatus: outcome.status,
      lastRunError: outcome.error,
      runCount: current.runCount + 1,
      updatedAt: yield* nowIso,
    };
    yield* save(finished);
    return finished;
  });

  const runNow: ScheduledTasks["Service"]["runNow"] = (taskId) =>
    lock
      .withPermits(1)(Effect.flatMap(find(taskId), (task) => fire(task, "manual")))
      .pipe(Effect.tap(() => publish));

  const runDue: ScheduledTasks["Service"]["runDue"] = Effect.gen(function* () {
    const due = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const tasks = yield* list;
        const dueTasks = tasks.filter(
          (task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now,
        );
        yield* Effect.forEach(dueTasks, (task) => fire(task, "scheduled"), { discard: true });
        return dueTasks.length;
      }),
    );
    if (due > 0) yield* publish;
  }).pipe(Effect.catch((error) => Effect.logWarning("scheduled-tasks.sweep-failed", { error })));

  /** Milliseconds until the next armed run, capped so the table is re-read regularly. */
  const idleMs = Effect.gen(function* () {
    const tasks = yield* list;
    const now = yield* nowMs;
    const next = tasks.reduce<number>((soonest, task) => {
      if (!task.enabled || task.nextRunAt === null) return soonest;
      return Math.min(soonest, (parseIsoMs(task.nextRunAt) ?? now) - now);
    }, MAX_IDLE_MS);
    return Math.max(0, next);
  }).pipe(Effect.orElseSucceed(() => MAX_IDLE_MS));

  const start: ScheduledTasks["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        yield* runDue;
        const waitMs = yield* idleMs;
        // Any create/update/run publishes to `wake`, so edits re-plan the wait immediately.
        yield* Effect.raceFirst(Effect.sleep(Duration.millis(waitMs)), Queue.take(wake));
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning("scheduled-tasks.loop-defect", { defect }),
        ),
        Effect.forever,
      ),
    ).pipe(Effect.asVoid);

  const stream = Stream.callback<ReadonlyArray<ScheduledTask>>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* list.pipe(Effect.orElseSucceed(() => [])));
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((tasks) => Effect.sync(() => Queue.offerUnsafe(mailbox, tasks))),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return ScheduledTasks.of({ list, create, update, remove, runNow, stream, runDue, start });
});

export const layer = Layer.effect(ScheduledTasks, make);
