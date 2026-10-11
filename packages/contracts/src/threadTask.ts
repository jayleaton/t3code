import * as Schema from "effect/Schema";

import {
  EnvironmentId,
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

/** Longest check-back a worker may declare for its own watcher. */
export const THREAD_TASK_CHECK_BACK_MAX_MINUTES = 24 * 60;

export const ThreadTaskCheckBackNote = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

/**
 * A worker's own watcher (a background command, a monitor, an external
 * script) that T3 cannot see. Until `at`, the task's turn ends are not
 * reported; if nothing changed by then, the owner is woken once. Any content
 * change clears it.
 */
export const ThreadTaskCheckBack = Schema.Struct({
  at: IsoDateTime,
  note: ThreadTaskCheckBackNote,
});
export type ThreadTaskCheckBack = typeof ThreadTaskCheckBack.Type;

export const ThreadTaskActor = Schema.Literals(["owner", "worker", "self", "user", "server"]);
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
  /** The owner is on another environment; its environment queues the wake on delivery. */
  "owner_remote",
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
  /**
   * Set on a `run_ended` wake raised because this check-back passed without a
   * change. Older environments ignore it and read the wake as a turn end.
   */
  checkBack: Schema.optionalKey(ThreadTaskCheckBack),
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
  /**
   * Where the owner and worker chats live, null meaning this environment. The
   * worker's environment holds the authoritative record; a row with a
   * workerEnvironmentId is the owner's read-only mirror of it.
   */
  ownerEnvironmentId: Schema.NullOr(EnvironmentId),
  workerEnvironmentId: Schema.NullOr(EnvironmentId),
  /** repo:<canonical remote> for git projects, or an explicit key given at assignment. */
  projectKey: TrimmedNonEmptyString,
  status: ThreadTaskStatus,
  revision: PositiveInt,
  cursor: NonNegativeInt,
  summary: ThreadTaskSummary,
  needs: Schema.NullOr(ThreadTaskNeeds),
  questionRequestId: Schema.NullOr(RuntimeRequestId),
  evidence: ThreadTaskEvidence,
  waitingOn: Schema.NullOr(ThreadTaskContinuation),
  /** WAITING only: the worker's own watcher and when to check back. Absent on older records. */
  checkBack: Schema.optionalKey(Schema.NullOr(ThreadTaskCheckBack)),
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
/** Delivery between a worker's environment and its owner's. */
export const ThreadTaskSync = Schema.Struct({
  peerEnvironmentId: EnvironmentId,
  /** pending: changes not yet acknowledged; unreachable: the last attempt failed. */
  state: Schema.Literals(["synced", "pending", "unreachable"]),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type ThreadTaskSync = typeof ThreadTaskSync.Type;

export const ThreadTaskView = Schema.Struct({
  task: ThreadTask,
  /** Null for a task whose owner and worker share this environment. */
  sync: Schema.NullOr(ThreadTaskSync),
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
  projectKey: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description:
        "Explicit project key for a project without a git remote, so chats on different machines group together. Git projects use their remote automatically.",
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
  checkBack: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        minutes: PositiveInt.check(Schema.isLessThanOrEqualTo(THREAD_TASK_CHECK_BACK_MAX_MINUTES)),
        note: ThreadTaskCheckBackNote,
      }),
    ).annotate({
      description:
        "WAITING only: your own watcher covers this task. Turn ends are not reported for `minutes`; if nothing changed by then your owner is woken once. null clears it; any content change also clears it.",
    }),
  ),
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
  /** The other environment could not be reached; nothing changed there. */
  "unreachable",
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

export const ThreadSettleBlock = Schema.Literals([
  /** Pinned, or automatic settlement turned off: a human hold. */
  "held",
  "active_run",
  "queued_run",
  "pending_descendant",
  "open_task",
]);
export type ThreadSettleBlock = typeof ThreadSettleBlock.Type;

/**
 * A chat's request to settle itself once its current turn ends. It settles
 * only when no run, queued wake, active descendant, or unaccepted child task
 * remains; until then `blockedBy` says why.
 */
export const ThreadSettleRequest = Schema.Struct({
  threadId: ThreadId,
  requestedBy: ThreadTaskActor,
  requestedAt: IsoDateTime,
  /** The run that was active when the request was made, if any. */
  afterRunId: Schema.NullOr(RunId),
  state: Schema.Literals(["pending", "settled", "cancelled"]),
  blockedBy: Schema.NullOr(ThreadSettleBlock),
  updatedAt: IsoDateTime,
});
export type ThreadSettleRequest = typeof ThreadSettleRequest.Type;

export const ThreadSettleAfterTurnInput = Schema.Struct({
  threadId: Schema.optional(
    ThreadId.annotate({
      description: "Omit for your own chat. Only that chat or the user may ask.",
    }),
  ),
  cancel: Schema.optional(
    Schema.Literal(true).annotate({ description: "Withdraw a pending request." }),
  ),
});
export type ThreadSettleAfterTurnInput = typeof ThreadSettleAfterTurnInput.Type;

/**
 * Calls between the owner's and the worker's environments, relayed by a
 * connected T3 app. Each carries the task's capability, a secret both servers
 * keep and agents never see, so the receiver acts only as that task's peer.
 */
const ThreadTaskCapability = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const ThreadTaskRemoteAssignInput = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  ownerThreadId: ThreadId,
  workerThreadId: ThreadId,
  taskId: ThreadTaskId,
  summary: ThreadTaskSummary,
  settleWhenAccepted: Schema.optional(Schema.Boolean),
  projectKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  capability: ThreadTaskCapability,
});
export type ThreadTaskRemoteAssignInput = typeof ThreadTaskRemoteAssignInput.Type;

export const ThreadTaskRemoteDeliverInput = Schema.Struct({
  workerEnvironmentId: EnvironmentId,
  capability: ThreadTaskCapability,
  view: ThreadTaskView,
});
export type ThreadTaskRemoteDeliverInput = typeof ThreadTaskRemoteDeliverInput.Type;

export const ThreadTaskRemoteOwnerActionInput = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  capability: ThreadTaskCapability,
  update: ThreadTaskUpdateInput,
});
export type ThreadTaskRemoteOwnerActionInput = typeof ThreadTaskRemoteOwnerActionInput.Type;

export const ThreadTaskRemoteDeliverResult = Schema.Struct({ applied: Schema.Boolean });
export type ThreadTaskRemoteDeliverResult = typeof ThreadTaskRemoteDeliverResult.Type;

export const THREAD_TASK_PROJECT_LIMIT = 200;

export const ThreadTaskProjectSnapshotInput = Schema.Struct({
  projectKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ThreadTaskProjectSnapshotInput = typeof ThreadTaskProjectSnapshotInput.Type;

/** One environment's own task records for a project key, newest first, bounded. */
export const ThreadTaskProjectSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  generatedAt: IsoDateTime,
  tasks: Schema.Array(ThreadTaskView),
  truncated: Schema.Boolean,
});
export type ThreadTaskProjectSnapshot = typeof ThreadTaskProjectSnapshot.Type;

export const ThreadTaskBoardInput = Schema.Struct({
  projectKey: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Omit for your own chat's project.",
    }),
  ),
});
export type ThreadTaskBoardInput = typeof ThreadTaskBoardInput.Type;

/**
 * A read-only view of one project's tasks across this environment and every
 * environment a connected app reaches, grouped by owning chat. `coverage`
 * says which environments answered; a task seen only through this
 * environment's mirror is marked `mirror` and may be stale.
 */
export const ThreadTaskBoard = Schema.Struct({
  projectKey: TrimmedNonEmptyString,
  generatedAt: IsoDateTime,
  coverage: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      state: Schema.Literals(["local", "live", "unreachable"]),
      tasks: NonNegativeInt,
      truncated: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    }),
  ),
  owners: Schema.Array(
    Schema.Struct({
      ownerEnvironmentId: EnvironmentId,
      ownerThreadId: ThreadId,
      tasks: Schema.Array(
        Schema.Struct({
          workerEnvironmentId: EnvironmentId,
          source: Schema.Literals(["live", "mirror"]),
          view: ThreadTaskView,
        }),
      ),
    }),
  ),
});
export type ThreadTaskBoard = typeof ThreadTaskBoard.Type;
