import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * The deliverable state a worker chat reports to the chat that owns its task.
 * It is separate from run state: a finished turn is not a finished task.
 *
 * - WAITING: work continues on a registered continuation (`waitingOn`).
 * - INPUT: the worker cannot continue without the decision or dependency in `needs`.
 * - DONE: the worker reports the deliverable ready, with evidence. Only the
 *   owner's acceptance of that exact revision completes it.
 */
export const ThreadTaskStatus = Schema.Literals(["WAITING", "INPUT", "DONE"]);
export type ThreadTaskStatus = typeof ThreadTaskStatus.Type;

export const ThreadTaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ThreadTaskId = typeof ThreadTaskId.Type;

export const ThreadTaskSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
export const ThreadTaskNeeds = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
export const ThreadTaskEvidenceItem = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
export const ThreadTaskEvidence = Schema.Array(ThreadTaskEvidenceItem).check(
  Schema.isMaxLength(20),
);

/** What a WAITING task resumes on. The server checks that it exists when it is set. */
export const ThreadTaskContinuation = Schema.Union([
  /** The worker's own live run. */
  Schema.Struct({ kind: Schema.Literal("run") }),
  /** A pull request watched by the worker or its owner. */
  Schema.Struct({
    kind: Schema.Literal("pull_request"),
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
  /** An unfinished task of one of the worker's own child chats. */
  Schema.Struct({ kind: Schema.Literal("task"), threadId: ThreadId }),
]);
export type ThreadTaskContinuation = typeof ThreadTaskContinuation.Type;

export const ThreadTaskActor = Schema.Literals(["owner", "worker", "user", "server"]);
export type ThreadTaskActor = typeof ThreadTaskActor.Type;

export const ThreadTaskWakeReason = Schema.Literals([
  "input",
  "done",
  "gate",
  "question",
  "run_ended",
]);
export type ThreadTaskWakeReason = typeof ThreadTaskWakeReason.Type;

export const ThreadTaskWakeSkipReason = Schema.Literals([
  "owner_settled",
  "owner_archived",
  "owner_missing",
]);
export type ThreadTaskWakeSkipReason = typeof ThreadTaskWakeSkipReason.Type;

/**
 * The latest owner wake. `pending` is the outbox entry a restart replays;
 * `delivered` means the wake message was queued on the owner.
 */
export const ThreadTaskWake = Schema.Struct({
  id: TrimmedNonEmptyString,
  reason: ThreadTaskWakeReason,
  revision: PositiveInt,
  runId: Schema.NullOr(RunId),
  state: Schema.Literals(["pending", "delivered", "skipped"]),
  skipReason: Schema.NullOr(ThreadTaskWakeSkipReason),
  createdAt: IsoDateTime,
});
export type ThreadTaskWake = typeof ThreadTaskWake.Type;

export const ThreadTaskSettlementBlock = Schema.Literals([
  "not_accepted",
  "active_run",
  "pending_descendant",
]);
export type ThreadTaskSettlementBlock = typeof ThreadTaskSettlementBlock.Type;

export const ThreadTaskSettlement = Schema.Struct({
  state: Schema.Literals(["none", "pending", "settled"]),
  blockedBy: Schema.NullOr(ThreadTaskSettlementBlock),
});
export type ThreadTaskSettlement = typeof ThreadTaskSettlement.Type;

/** The owner's standing consent to settle the worker once its task is accepted. */
export const ThreadTaskSettleConsent = Schema.Struct({
  grantedBy: ThreadTaskActor,
  grantedAt: IsoDateTime,
});

/** The owner's acceptance of one DONE revision. Any later content change invalidates it. */
export const ThreadTaskAcceptance = Schema.Struct({
  revision: PositiveInt,
  acceptedBy: ThreadTaskActor,
  acceptedAt: IsoDateTime,
});

/**
 * One task per worker chat, owned by the worker's parent chat. `revision`
 * counts content changes and guards updates; `cursor` orders every change for
 * watchers, including server bookkeeping.
 */
export const ThreadTask = Schema.Struct({
  taskId: ThreadTaskId,
  workerThreadId: ThreadId,
  ownerThreadId: ThreadId,
  status: ThreadTaskStatus,
  revision: PositiveInt,
  cursor: NonNegativeInt,
  summary: ThreadTaskSummary,
  needs: Schema.NullOr(ThreadTaskNeeds),
  questionRequestId: Schema.NullOr(RuntimeRequestId),
  evidence: ThreadTaskEvidence,
  waitingOn: Schema.NullOr(ThreadTaskContinuation),
  settleWhenAccepted: Schema.NullOr(ThreadTaskSettleConsent),
  acceptance: Schema.NullOr(ThreadTaskAcceptance),
  settlement: ThreadTaskSettlement,
  wake: Schema.NullOr(ThreadTaskWake),
  /** The latest worker run whose end this task has reported. */
  observedRunId: Schema.NullOr(RunId),
  /** The clientRequestId of the latest applied change, so a retry returns it. */
  lastRequestId: Schema.NullOr(TrimmedNonEmptyString),
  assignedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  updatedBy: ThreadTaskActor,
});
export type ThreadTask = typeof ThreadTask.Type;

/** A task with the facts a reader needs to trust it, derived when it is read. */
export const ThreadTaskView = Schema.Struct({
  task: ThreadTask,
  workerRun: Schema.Literals(["running", "waiting_input", "idle"]),
  /** True only while `waitingOn` names something that still exists. */
  continuationLive: Schema.Boolean,
  accepted: Schema.Boolean,
});
export type ThreadTaskView = typeof ThreadTaskView.Type;

export const ThreadTaskAssignInput = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The child chat that works on the task." }),
  summary: ThreadTaskSummary.annotate({ description: "The deliverable, in a sentence or two." }),
  taskId: Schema.optional(
    ThreadTaskId.annotate({ description: "Your ledger's id for the task. Defaults to a new id." }),
  ),
  settleWhenAccepted: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Standing consent to settle the child once you accept its DONE revision. Not acceptance itself.",
    }),
  ),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type ThreadTaskAssignInput = typeof ThreadTaskAssignInput.Type;

export const ThreadTaskReadInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description:
        "A child chat whose task you own, or your own chat. Omit to list every task you own.",
    }),
  ),
});
export type ThreadTaskReadInput = typeof ThreadTaskReadInput.Type;

export const ThreadTaskUpdateInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({ description: "The worker chat. Omit to update your own task." }),
  ),
  expectedRevision: PositiveInt.annotate({
    description: "The revision you read. A newer revision rejects the update.",
  }),
  status: Schema.optional(ThreadTaskStatus),
  summary: Schema.optional(ThreadTaskSummary),
  needs: Schema.optional(
    Schema.NullOr(ThreadTaskNeeds).annotate({
      description: "INPUT only: the missing decision or dependency.",
    }),
  ),
  questionRequestId: Schema.optional(Schema.NullOr(RuntimeRequestId)),
  evidence: Schema.optional(ThreadTaskEvidence),
  waitingOn: Schema.optional(Schema.NullOr(ThreadTaskContinuation)),
  settleWhenAccepted: Schema.optional(Schema.Boolean.annotate({ description: "Owner only." })),
  accept: Schema.optional(
    Schema.Literal(true).annotate({
      description:
        "Owner only: accept this DONE revision after its gates (merge, deployment) passed.",
    }),
  ),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type ThreadTaskUpdateInput = typeof ThreadTaskUpdateInput.Type;

export const THREAD_TASK_WATCH_MAX_MS = 60_000;

export const ThreadTaskWatchInput = Schema.Struct({
  afterCursor: Schema.optional(NonNegativeInt),
  timeoutMs: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(THREAD_TASK_WATCH_MAX_MS)),
  ),
});
export type ThreadTaskWatchInput = typeof ThreadTaskWatchInput.Type;

export const ThreadTaskListResult = Schema.Struct({
  tasks: Schema.Array(ThreadTaskView),
  cursor: NonNegativeInt,
  timedOut: Schema.Boolean,
});
export type ThreadTaskListResult = typeof ThreadTaskListResult.Type;

export const ThreadTaskErrorCode = Schema.Literals([
  "task_not_found",
  "thread_not_found",
  "scope_denied",
  "revision_conflict",
  "invalid_transition",
  "continuation_missing",
  "pending_descendant",
]);
export type ThreadTaskErrorCode = typeof ThreadTaskErrorCode.Type;

export class ThreadTaskError extends Schema.TaggedError<ThreadTaskError>()("ThreadTaskError", {
  code: ThreadTaskErrorCode,
  detail: Schema.String,
  currentRevision: Schema.optional(PositiveInt),
}) {
  override get message(): string {
    return this.detail;
  }
}
