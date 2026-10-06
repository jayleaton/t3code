import {
  CommandId,
  MessageId,
  THREAD_TASK_WATCH_MAX_MS,
  ThreadTaskError,
  threadParentRelationship,
  type OrchestrationV2Notification,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
  type ThreadTask,
  type ThreadTaskActor,
  type ThreadTaskAssignInput,
  type ThreadTaskContinuation,
  type ThreadTaskListResult,
  type ThreadTaskReadInput,
  type ThreadTaskUpdateInput,
  type ThreadTaskView,
  type ThreadTaskWake,
  type ThreadTaskWakeReason,
  type ThreadTaskWakeSkipReason,
  type ThreadTaskWatchInput,
  type ThreadSettleAfterTurnInput,
  type ThreadSettleRequest,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { threadShellHasActiveWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  threadPullRequestsOf,
  threadPullRequestWatchesSuspended,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadTaskStore from "./ThreadTaskStore.ts";

/**
 * Who is acting. A thread caller comes from the authenticated MCP invocation;
 * `user` is an authorized client without a calling thread, with owner rights.
 */
export type ThreadTaskCaller =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "user" };

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const fail = (code: ThreadTaskError["code"], detail: string, currentRevision?: number) =>
  new ThreadTaskError({
    code,
    detail,
    ...(currentRevision === undefined ? {} : { currentRevision }),
  });

const isAccepted = (task: ThreadTask) =>
  task.status === "DONE" && task.acceptance?.revision === task.revision;

const sameContinuation = (
  left: ThreadTaskContinuation | null,
  right: ThreadTaskContinuation | null,
) => {
  if (left === null || right === null) return left === right;
  switch (left.kind) {
    case "run":
      return right.kind === "run";
    case "pull_request":
      return (
        right.kind === "pull_request" &&
        left.repository === right.repository &&
        left.number === right.number
      );
    case "task":
      return right.kind === "task" && left.threadId === right.threadId;
  }
};

const sameEvidence = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/**
 * Typed task records between an owner chat and its child worker chats: the
 * worker reports WAITING/INPUT/DONE, the owner accepts, and meaningful
 * transitions wake the owner through a queued notification. Run lifecycle is
 * read, never replaced.
 */
export class ThreadTaskService extends Context.Service<
  ThreadTaskService,
  {
    readonly assign: (
      caller: ThreadTaskCaller,
      input: ThreadTaskAssignInput,
    ) => Effect.Effect<ThreadTaskView, ThreadTaskError>;
    /** Assigns a task to a named child chat at launch, unless it already has one. */
    readonly assignLaunchedChild: (input: {
      readonly ownerThreadId: ThreadId;
      readonly workerThreadId: ThreadId;
      readonly summary: string;
    }) => Effect.Effect<void>;
    readonly read: (
      caller: ThreadTaskCaller,
      input: ThreadTaskReadInput,
    ) => Effect.Effect<ThreadTaskListResult, ThreadTaskError>;
    readonly update: (
      caller: ThreadTaskCaller,
      input: ThreadTaskUpdateInput,
    ) => Effect.Effect<ThreadTaskView, ThreadTaskError>;
    /** Changes after `afterCursor`, waiting up to `timeoutMs` for the first one. */
    readonly watch: (
      caller: ThreadTaskCaller,
      input: ThreadTaskWatchInput,
    ) => Effect.Effect<ThreadTaskListResult, ThreadTaskError>;
    /** Delivers wakes and settlements a stopped server left unfinished. */
    /**
     * Records a chat's request to settle once its current turn ends and nothing
     * it owns is still working, or withdraws it. Only the chat itself or the
     * user may ask.
     */
    readonly settleAfterTurn: (
      caller: ThreadTaskCaller,
      input: ThreadSettleAfterTurnInput,
    ) => Effect.Effect<ThreadSettleRequest, ThreadTaskError>;
    /**
     * Whether a chat may message another. A managed worker (a chat with a task)
     * reports through its task instead; it may message only its own children.
     * Chats without a task, and the user, are not restricted here.
     */
    readonly authorizeMessage: (input: {
      readonly senderThreadId: ThreadId;
      /** Null when the target is on another environment. */
      readonly targetThreadId: ThreadId | null;
    }) => Effect.Effect<void, ThreadTaskError>;
    readonly recover: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Waits until every committed event has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/threadTask/ThreadTaskService") {}

export const make = Effect.gen(function* () {
  const store = yield* ThreadTaskStore.ThreadTaskStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  const writes = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();

  const unavailable = (cause: unknown) =>
    Effect.logWarning("thread task read failed", { cause }).pipe(
      Effect.andThen(Effect.fail(fail("thread_not_found", "The thread could not be read."))),
    );
  const getTask = (workerThreadId: ThreadId) =>
    store.get(workerThreadId).pipe(Effect.catch(unavailable), Effect.map(Option.getOrUndefined));
  const getShell = (threadId: ThreadId) =>
    projections.getThreadShell(threadId).pipe(
      Effect.catch(unavailable),
      Effect.map((shell) => (shell === null || shell.deletedAt != null ? undefined : shell)),
    );
  const requireShell = (threadId: ThreadId) =>
    getShell(threadId).pipe(
      Effect.flatMap((shell) =>
        shell === undefined
          ? Effect.fail(fail("thread_not_found", `Thread ${threadId} was not found.`))
          : Effect.succeed(shell),
      ),
    );
  const put = (task: ThreadTask) =>
    store.put(task).pipe(
      Effect.tap(() => PubSub.publish(changes, undefined)),
      Effect.catch((cause) =>
        Effect.logWarning("thread task write failed", { cause }).pipe(
          Effect.andThen(Effect.fail(fail("task_not_found", "The task could not be saved."))),
        ),
      ),
    );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const hasLiveRun = (shell: OrchestrationV2ThreadShell) =>
    shell.activeRunId != null || threadShellHasActiveWork(shell);

  /** Tasks the worker owns that its owner has not accepted yet. */
  const openChildTasks = (workerThreadId: ThreadId) =>
    store.listByOwner(workerThreadId).pipe(
      Effect.map((tasks) => tasks.filter((task) => !isAccepted(task))),
      Effect.catch(unavailable),
    );

  const continuationExists = (task: ThreadTask, continuation: ThreadTaskContinuation) =>
    Effect.gen(function* () {
      switch (continuation.kind) {
        case "run": {
          const shell = yield* getShell(task.workerThreadId);
          return shell !== undefined && hasLiveRun(shell);
        }
        case "pull_request": {
          // Registered is not live: a settled, archived, or deleted thread parks its watches.
          for (const threadId of [task.workerThreadId, task.ownerThreadId]) {
            const thread = yield* projections
              .getThread(threadId)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (
              thread === undefined ||
              thread.deletedAt != null ||
              threadPullRequestWatchesSuspended(thread)
            )
              continue;
            const watched = visibleThreadPullRequests(threadPullRequestsOf(thread)).some(
              (link) =>
                link.watch !== undefined &&
                link.repository.toLowerCase() === continuation.repository.toLowerCase() &&
                link.number === continuation.number,
            );
            if (watched) return true;
          }
          return false;
        }
        case "task": {
          const child = yield* getTask(continuation.threadId);
          return (
            child !== undefined && child.ownerThreadId === task.workerThreadId && !isAccepted(child)
          );
        }
      }
    });

  const view = (task: ThreadTask) =>
    Effect.gen(function* () {
      const shell = yield* getShell(task.workerThreadId);
      const workerRun: ThreadTaskView["workerRun"] =
        shell?.pendingRuntimeRequest?.kind === "user_input"
          ? "waiting_input"
          : shell !== undefined && hasLiveRun(shell)
            ? "running"
            : "idle";
      const continuationLive =
        task.status === "WAITING" &&
        task.waitingOn !== null &&
        task.wake?.state !== "skipped" &&
        (yield* continuationExists(task, task.waitingOn));
      return { task, workerRun, continuationLive, accepted: isAccepted(task) } as ThreadTaskView;
    });

  /** The caller's role on a task, checking the owner is still the worker's parent. */
  const roleOf = (
    caller: ThreadTaskCaller,
    task: ThreadTask,
    worker: OrchestrationV2ThreadShell,
  ) => {
    if (worker.parentThreadId !== task.ownerThreadId) return undefined;
    if (caller.kind === "user") return "user" as const;
    if (caller.threadId === task.workerThreadId) return "worker" as const;
    if (caller.threadId === task.ownerThreadId) return "owner" as const;
    return undefined;
  };

  // ---- wakes -------------------------------------------------------------

  const wakeOutcome = (
    reason: ThreadTaskWakeReason,
    runStatus: string | undefined,
  ): OrchestrationV2Notification["outcome"] => {
    if (reason === "done") return "completed";
    if (reason === "run_ended") {
      if (runStatus === "failed") return "failed";
      if (runStatus === "interrupted" || runStatus === "cancelled") return "cancelled";
    }
    return "updated";
  };

  const wakeMessage = (task: ThreadTask, reason: ThreadTaskWakeReason, runStatus?: string) => {
    const short = task.summary.split("\n")[0]!.slice(0, 80);
    const headline =
      reason === "done"
        ? `Task "${short}" reports DONE`
        : reason === "input" || reason === "question"
          ? `Task "${short}" needs input`
          : reason === "gate"
            ? `Task "${short}" is waiting on a new gate`
            : `Task "${short}" turn ${runStatus ?? "ended"}`;
    const lines = [
      `${headline}. Worker chat ${task.workerThreadId}, task ${task.taskId}, status ${task.status}, revision ${task.revision}.`,
      ...(task.needs === null ? [] : [`Needs: ${task.needs}`]),
      ...(reason === "done"
        ? [
            `Evidence: ${task.evidence.join("; ")}`,
            "Verify its gates, then accept this revision with t3_task_update accept=true.",
          ]
        : []),
      ...(reason === "run_ended"
        ? ["A finished turn is not a finished task: read it with t3_task_read and follow up."]
        : []),
    ];
    const notification: OrchestrationV2Notification = {
      source: { kind: "subagent", childThreadId: task.workerThreadId },
      outcome: wakeOutcome(reason, runStatus),
      summary: headline,
    };
    return { text: lines.join("\n"), notification };
  };

  /** Queues the pending wake on the owner, then records what happened to it. */
  const deliverWake = (workerThreadId: ThreadId, runStatus?: string) =>
    Effect.gen(function* () {
      const task = yield* getTask(workerThreadId);
      const wake = task?.wake;
      if (task === undefined || wake == null || wake.state !== "pending") return;
      const owner = yield* getShell(task.ownerThreadId);
      const skipReason: ThreadTaskWakeSkipReason | null =
        owner === undefined
          ? "owner_missing"
          : owner.archivedAt != null
            ? "owner_archived"
            : owner.settledOverride === "settled"
              ? "owner_settled"
              : null;
      if (skipReason === null) {
        const message = wakeMessage(task, wake.reason, runStatus);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:thread-task-wake:${wake.id}`),
          threadId: task.ownerThreadId,
          messageId: MessageId.make(`message:thread-task-wake:${wake.id}`),
          text: message.text,
          notification: message.notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        });
      }
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getTask(workerThreadId);
          if (current?.wake?.id !== wake.id || current.wake.state !== "pending") return;
          yield* put({
            ...current,
            wake: {
              ...current.wake,
              state: skipReason === null ? "delivered" : "skipped",
              skipReason,
            },
          });
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread task wake was not delivered", {
          workerThreadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const pendingWake = (input: {
    readonly id: string;
    readonly reason: ThreadTaskWakeReason;
    readonly revision: number;
    readonly runId: RunId | null;
    readonly createdAt: string;
  }): ThreadTaskWake => ({ ...input, state: "pending", skipReason: null });

  // ---- settlement --------------------------------------------------------

  /**
   * Settles an accepted worker whose owner consented, once its work is quiet.
   * Settlement cascades to the worker's own sub-runs.
   */
  const evaluateSettlement = (workerThreadId: ThreadId) =>
    Effect.gen(function* () {
      const task = yield* getTask(workerThreadId);
      if (
        task === undefined ||
        task.settleWhenAccepted === null ||
        task.settlement.state === "settled"
      )
        return;
      const shell = yield* getShell(workerThreadId);
      if (shell === undefined) return;
      const blockedBy: ThreadTask["settlement"]["blockedBy"] = !isAccepted(task)
        ? "not_accepted"
        : hasLiveRun(shell)
          ? "active_run"
          : (yield* openChildTasks(workerThreadId)).length > 0 ||
              (yield* projections
                .hasActiveDescendants(workerThreadId)
                .pipe(Effect.orElseSucceed(() => true)))
            ? "pending_descendant"
            : null;
      let settled = false;
      if (blockedBy === null) {
        settled = yield* orchestrator
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(
              `server:thread-task-settle:${workerThreadId}:${task.revision}`,
            ),
            threadId: workerThreadId,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logInfo("accepted thread task kept its settlement pending", {
                workerThreadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
      }
      const settlement: ThreadTask["settlement"] = settled
        ? { state: "settled", blockedBy: null }
        : !isAccepted(task)
          ? { state: "none", blockedBy: "not_accepted" }
          : { state: "pending", blockedBy: blockedBy ?? "active_run" };
      if (
        settlement.state === task.settlement.state &&
        settlement.blockedBy === task.settlement.blockedBy
      )
        return;
      yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getTask(workerThreadId);
          if (current === undefined || current.revision !== task.revision) return;
          yield* put({ ...current, settlement, updatedAt: yield* nowIso });
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread task settlement failed", {
          workerThreadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // ---- commands ----------------------------------------------------------

  const writeAssignment = (input: {
    readonly owner: ThreadId;
    readonly actor: ThreadTaskActor;
    readonly worker: OrchestrationV2ThreadShell;
    readonly summary: string;
    readonly taskId: string | undefined;
    readonly settleWhenAccepted: boolean | undefined;
    readonly clientRequestId: string | undefined;
    readonly existing: ThreadTask | undefined;
  }) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const existing = input.existing;
      const task: ThreadTask = {
        taskId: input.taskId ?? existing?.taskId ?? `task:${yield* randomUuidV4}`,
        workerThreadId: input.worker.id,
        ownerThreadId: input.owner,
        status: "WAITING",
        revision: (existing?.revision ?? 0) + 1,
        cursor: 0,
        summary: input.summary,
        needs: null,
        questionRequestId: null,
        evidence: [],
        waitingOn: { kind: "run" },
        settleWhenAccepted:
          input.settleWhenAccepted === true
            ? { grantedBy: input.actor, grantedAt: now }
            : input.settleWhenAccepted === false
              ? null
              : (existing?.settleWhenAccepted ?? null),
        acceptance: null,
        settlement: { state: "none", blockedBy: null },
        wake: existing?.wake ?? null,
        observedRunId: existing?.observedRunId ?? null,
        lastRequestId: input.clientRequestId ?? null,
        assignedAt: now,
        updatedAt: now,
        updatedBy: input.actor,
      };
      return yield* put(task);
    });

  const assign: ThreadTaskService["Service"]["assign"] = (caller, input) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const worker = yield* requireShell(input.threadId);
          const owner = worker.parentThreadId;
          if (
            owner == null ||
            worker.parentEnvironmentId != null ||
            threadParentRelationship(worker) !== "child" ||
            (caller.kind === "thread" && caller.threadId !== owner)
          ) {
            return yield* fail(
              "scope_denied",
              "Only the chat that a child chat is nested under can assign it a task.",
            );
          }
          const existing = yield* getTask(worker.id);
          if (
            existing !== undefined &&
            input.clientRequestId !== undefined &&
            existing.lastRequestId === input.clientRequestId
          ) {
            return existing;
          }
          return yield* writeAssignment({
            owner,
            actor: caller.kind === "user" ? "user" : "owner",
            worker,
            summary: input.summary,
            taskId: input.taskId,
            settleWhenAccepted: input.settleWhenAccepted,
            clientRequestId: input.clientRequestId,
            existing,
          });
        }),
      )
      .pipe(Effect.flatMap(view));

  const assignLaunchedChild: ThreadTaskService["Service"]["assignLaunchedChild"] = (input) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const worker = yield* requireShell(input.workerThreadId);
          if (
            worker.parentThreadId !== input.ownerThreadId ||
            threadParentRelationship(worker) !== "child" ||
            (yield* getTask(worker.id)) !== undefined
          )
            return;
          yield* writeAssignment({
            owner: input.ownerThreadId,
            actor: "owner",
            worker,
            summary: input.summary,
            taskId: undefined,
            settleWhenAccepted: undefined,
            clientRequestId: undefined,
            existing: undefined,
          });
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("launched child kept no task", {
            workerThreadId: input.workerThreadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  const visibleTasks = (caller: ThreadTaskCaller, afterCursor: number) =>
    store
      .listVisible({ threadId: caller.kind === "user" ? null : caller.threadId, afterCursor })
      .pipe(Effect.catch(unavailable));

  const read: ThreadTaskService["Service"]["read"] = (caller, input) =>
    Effect.gen(function* () {
      const cursor = yield* store.latestCursor.pipe(Effect.catch(unavailable));
      if (input.threadId === undefined) {
        const tasks = yield* visibleTasks(caller, 0);
        return { tasks: yield* Effect.forEach(tasks, view), cursor, timedOut: false };
      }
      const task = yield* getTask(input.threadId);
      if (task === undefined) {
        return yield* fail("task_not_found", `Thread ${input.threadId} has no task.`);
      }
      const worker = yield* requireShell(task.workerThreadId);
      if (roleOf(caller, task, worker) === undefined) {
        return yield* fail("scope_denied", "Only a task's worker or owner can read it.");
      }
      return { tasks: [yield* view(task)], cursor, timedOut: false };
    });

  const validate = (task: ThreadTask, worker: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      switch (task.status) {
        case "WAITING": {
          if (task.waitingOn === null) {
            return yield* fail("invalid_transition", "WAITING needs waitingOn.");
          }
          if (!(yield* continuationExists(task, task.waitingOn))) {
            return yield* fail(
              "continuation_missing",
              `Nothing registered resumes this task (waitingOn ${task.waitingOn.kind}).`,
            );
          }
          return;
        }
        case "INPUT": {
          if (task.needs === null) {
            return yield* fail(
              "invalid_transition",
              "INPUT needs `needs`: the missing decision or dependency.",
            );
          }
          if (
            task.questionRequestId !== null &&
            (worker.pendingRuntimeRequest?.id !== task.questionRequestId ||
              worker.pendingRuntimeRequest.kind !== "user_input")
          ) {
            return yield* fail(
              "invalid_transition",
              "questionRequestId must be the worker's pending question.",
            );
          }
          return;
        }
        case "DONE": {
          if (task.evidence.length === 0) {
            return yield* fail("invalid_transition", "DONE needs evidence of the deliverable.");
          }
          const open = yield* openChildTasks(task.workerThreadId);
          if (open.length > 0) {
            return yield* fail(
              "pending_descendant",
              `Child tasks are not accepted yet: ${open.map((child) => child.workerThreadId).join(", ")}.`,
            );
          }
          return;
        }
      }
    });

  const update: ThreadTaskService["Service"]["update"] = (caller, input) =>
    writes
      .withPermits(1)(
        Effect.gen(function* () {
          const workerThreadId =
            input.threadId ?? (caller.kind === "thread" ? caller.threadId : undefined);
          if (workerThreadId === undefined) {
            return yield* fail("thread_not_found", "threadId is required without a calling chat.");
          }
          const task = yield* getTask(workerThreadId);
          if (task === undefined) {
            return yield* fail("task_not_found", `Thread ${workerThreadId} has no task.`);
          }
          const worker = yield* requireShell(workerThreadId);
          const role = roleOf(caller, task, worker);
          if (role === undefined) {
            return yield* fail("scope_denied", "Only a task's worker or owner can update it.");
          }
          if (input.clientRequestId !== undefined && input.clientRequestId === task.lastRequestId) {
            return { task, wake: false };
          }
          if (input.expectedRevision !== task.revision) {
            return yield* fail(
              "revision_conflict",
              `The task is at revision ${task.revision}; read it again before updating.`,
              task.revision,
            );
          }
          if (
            role === "worker" &&
            (input.accept !== undefined || input.settleWhenAccepted !== undefined)
          ) {
            return yield* fail(
              "scope_denied",
              "Only the owner can accept a task or consent to its settlement.",
            );
          }
          const now = yield* nowIso;
          const actor: ThreadTaskActor = role;
          const status = input.status ?? task.status;
          const statusChanged = status !== task.status;
          const content = {
            status,
            summary: input.summary ?? task.summary,
            needs:
              status === "INPUT" ? (input.needs !== undefined ? input.needs : task.needs) : null,
            questionRequestId:
              status === "INPUT"
                ? input.questionRequestId !== undefined
                  ? input.questionRequestId
                  : task.questionRequestId
                : null,
            evidence: input.evidence ?? task.evidence,
            waitingOn:
              status === "WAITING"
                ? input.waitingOn !== undefined
                  ? input.waitingOn
                  : statusChanged
                    ? { kind: "run" as const }
                    : task.waitingOn
                : null,
          };
          const contentChanged =
            content.status !== task.status ||
            content.summary !== task.summary ||
            content.needs !== task.needs ||
            content.questionRequestId !== task.questionRequestId ||
            !sameEvidence(content.evidence, task.evidence) ||
            !sameContinuation(content.waitingOn, task.waitingOn);
          if (input.accept === true && contentChanged) {
            return yield* fail(
              "invalid_transition",
              "Accept a revision as it is; send changes in a separate update.",
            );
          }
          let next: ThreadTask = {
            ...task,
            ...content,
            revision: contentChanged ? task.revision + 1 : task.revision,
            acceptance: contentChanged ? null : task.acceptance,
            settlement: contentChanged ? { state: "none", blockedBy: null } : task.settlement,
            lastRequestId: input.clientRequestId ?? null,
            updatedAt: now,
            updatedBy: actor,
          };
          if (contentChanged) yield* validate(next, worker);
          if (input.accept === true) {
            if (task.status !== "DONE") {
              return yield* fail("invalid_transition", "Only a DONE task can be accepted.");
            }
            yield* validate(next, worker);
            next = {
              ...next,
              acceptance: { revision: task.revision, acceptedBy: actor, acceptedAt: now },
            };
          }
          if (input.settleWhenAccepted !== undefined) {
            next = {
              ...next,
              settleWhenAccepted: input.settleWhenAccepted
                ? (task.settleWhenAccepted ?? { grantedBy: actor, grantedAt: now })
                : null,
            };
          }
          // Only the worker's meaningful transitions wake the owner; the
          // owner's own writes and summary churn never do.
          const reason: ThreadTaskWakeReason | null =
            role !== "worker" || !contentChanged
              ? null
              : next.status === "DONE" &&
                  (statusChanged || !sameEvidence(next.evidence, task.evidence))
                ? "done"
                : next.status === "INPUT" && (statusChanged || next.needs !== task.needs)
                  ? "input"
                  : next.status === "WAITING" &&
                      next.waitingOn?.kind !== "run" &&
                      !sameContinuation(next.waitingOn, task.waitingOn)
                    ? "gate"
                    : null;
          if (reason !== null) {
            next = {
              ...next,
              wake: pendingWake({
                id: `${task.workerThreadId}:revision:${next.revision}:${reason}`,
                reason,
                revision: next.revision,
                runId: worker.activeRunId,
                createdAt: now,
              }),
            };
          }
          return { task: yield* put(next), wake: reason !== null };
        }),
      )
      .pipe(
        Effect.tap(({ task, wake }) =>
          Effect.gen(function* () {
            if (wake) yield* deliverWake(task.workerThreadId);
            yield* evaluateSettlement(task.workerThreadId);
            // An accepted child task can be the last thing its owner's settle request waits on.
            yield* evaluateSettleRequest(task.ownerThreadId);
          }),
        ),
        Effect.flatMap(({ task }) =>
          getTask(task.workerThreadId).pipe(Effect.flatMap((current) => view(current ?? task))),
        ),
      );

  const watch: ThreadTaskService["Service"]["watch"] = (caller, input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const afterCursor = input.afterCursor;
        if (afterCursor === undefined) return yield* read(caller, {});
        const timeout = Duration.millis(
          Math.min(input.timeoutMs ?? 30_000, THREAD_TASK_WATCH_MAX_MS),
        );
        const poll = visibleTasks(caller, afterCursor);
        const first = yield* poll;
        const changed =
          first.length > 0
            ? first
            : yield* PubSub.take(subscription).pipe(
                Effect.andThen(poll),
                Effect.repeat({ until: (tasks) => tasks.length > 0 }),
                Effect.timeoutOption(timeout),
                Effect.map(Option.getOrElse(() => [] as ReadonlyArray<ThreadTask>)),
              );
        return {
          tasks: yield* Effect.forEach(changed, view),
          cursor: changed.reduce((max, task) => Math.max(max, task.cursor), afterCursor),
          timedOut: changed.length === 0,
        };
      }),
    );

  // ---- messaging -------------------------------------------------------

  const authorizeMessage: ThreadTaskService["Service"]["authorizeMessage"] = (input) =>
    Effect.gen(function* () {
      if (input.targetThreadId === input.senderThreadId) return;
      if ((yield* getTask(input.senderThreadId)) === undefined) return;
      const target =
        input.targetThreadId === null ? undefined : yield* getShell(input.targetThreadId);
      if (target?.parentThreadId === input.senderThreadId && target.parentEnvironmentId == null) {
        return;
      }
      return yield* fail(
        "scope_denied",
        "Managed workers do not message other chats. Update your task status with t3_task_update (INPUT for a decision, DONE with evidence); your Captain is woken and relays requests.",
      );
    });

  // ---- settle after turn -------------------------------------------------

  /** Settles a requesting chat once it is quiet, or records what still blocks it. */
  const evaluateSettleRequest = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const request = Option.getOrUndefined(yield* store.getSettleRequest(threadId));
      if (request === undefined || request.state !== "pending") return;
      const shell = yield* getShell(threadId);
      const now = yield* nowIso;
      // A message the user wrote after the request means they want the chat active.
      const userSpokeSince =
        shell?.latestUserAuthoredMessageAt != null &&
        DateTime.formatIso(shell.latestUserAuthoredMessageAt) > request.requestedAt;
      if (shell === undefined || userSpokeSince || shell.settledOverride === "settled") {
        yield* store.putSettleRequest({
          ...request,
          state: shell?.settledOverride === "settled" ? "settled" : "cancelled",
          blockedBy: null,
          updatedAt: now,
        });
        return;
      }
      const thread = yield* projections
        .getThread(threadId)
        .pipe(Effect.orElseSucceed(() => undefined));
      const blockedBy: ThreadSettleRequest["blockedBy"] =
        thread?.pinnedAt != null || thread?.autoSettleDisabledAt != null
          ? "held"
          : shell.status === "queued"
            ? "queued_run"
            : hasLiveRun(shell)
              ? "active_run"
              : (yield* openChildTasks(threadId)).length > 0
                ? "open_task"
                : (yield* projections
                      .hasActiveDescendants(threadId)
                      .pipe(Effect.orElseSucceed(() => true)))
                  ? "pending_descendant"
                  : null;
      let settled = false;
      if (blockedBy === null) {
        settled = yield* orchestrator
          .dispatch({
            type: "thread.settle",
            commandId: CommandId.make(
              `server:settle-after-turn:${threadId}:${request.requestedAt}`,
            ),
            threadId,
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logInfo("settle-after-turn kept waiting", {
                threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
      }
      const next: ThreadSettleRequest = settled
        ? { ...request, state: "settled", blockedBy: null, updatedAt: now }
        : { ...request, blockedBy: blockedBy ?? "active_run", updatedAt: now };
      if (next.state !== request.state || next.blockedBy !== request.blockedBy) {
        yield* store.putSettleRequest(next);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("settle-after-turn evaluation failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const reevaluateSettleRequests = store.listPendingSettleRequests().pipe(
    Effect.flatMap((requests) =>
      Effect.forEach(requests, (request) => evaluateSettleRequest(request.threadId), {
        discard: true,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("settle-after-turn sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const settleAfterTurn: ThreadTaskService["Service"]["settleAfterTurn"] = (caller, input) =>
    Effect.gen(function* () {
      const threadId = input.threadId ?? (caller.kind === "thread" ? caller.threadId : undefined);
      if (threadId === undefined) {
        return yield* fail("thread_not_found", "threadId is required without a calling chat.");
      }
      if (caller.kind === "thread" && caller.threadId !== threadId) {
        return yield* fail(
          "scope_denied",
          "A chat may only ask to settle itself; owners settle workers by accepting their tasks.",
        );
      }
      const shell = yield* requireShell(threadId);
      const existing = Option.getOrUndefined(
        yield* store.getSettleRequest(threadId).pipe(Effect.catch(unavailable)),
      );
      const now = yield* nowIso;
      if (input.cancel === true) {
        if (existing?.state === "pending") {
          yield* store
            .putSettleRequest({ ...existing, state: "cancelled", blockedBy: null, updatedAt: now })
            .pipe(Effect.catch(unavailable));
        }
      } else if (existing?.state !== "pending") {
        yield* store
          .putSettleRequest({
            threadId,
            requestedBy: caller.kind === "user" ? "user" : "self",
            requestedAt: now,
            afterRunId: shell.activeRunId,
            state: "pending",
            blockedBy: null,
            updatedAt: now,
          })
          .pipe(Effect.catch(unavailable));
        yield* evaluateSettleRequest(threadId);
      }
      const current = Option.getOrUndefined(
        yield* store.getSettleRequest(threadId).pipe(Effect.catch(unavailable)),
      );
      if (current === undefined) {
        return yield* fail("task_not_found", `Thread ${threadId} has no settle request.`);
      }
      return current;
    });

  // ---- reactions ---------------------------------------------------------

  const onRunEnded = (workerThreadId: ThreadId, runId: RunId, runStatus: string) =>
    Effect.gen(function* () {
      const wakeNow = yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const task = yield* getTask(workerThreadId);
          if (task === undefined || task.observedRunId === runId) return false;
          // A DONE/INPUT/gate wake raised during this run already told the owner.
          const reported =
            task.wake !== null && task.wake.runId === runId && task.wake.reason !== "run_ended";
          const quiet = reported || isAccepted(task) || task.settlement.state === "settled";
          yield* put({
            ...task,
            observedRunId: runId,
            ...(quiet
              ? {}
              : {
                  wake: pendingWake({
                    id: `${workerThreadId}:run:${runId}`,
                    reason: "run_ended",
                    revision: task.revision,
                    runId,
                    createdAt: yield* nowIso,
                  }),
                }),
          });
          return !quiet;
        }),
      );
      if (wakeNow) yield* deliverWake(workerThreadId, runStatus);
    });

  const onQuestion = (workerThreadId: ThreadId, requestId: RuntimeRequestId, pending: boolean) =>
    Effect.gen(function* () {
      const wakeNow = yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const task = yield* getTask(workerThreadId);
          if (task === undefined || task.settlement.state === "settled") return false;
          const now = yield* nowIso;
          if (!pending) {
            // An answered question no longer blocks the task.
            if (task.status !== "INPUT" || task.questionRequestId !== requestId) return false;
            yield* put({
              ...task,
              status: "WAITING",
              needs: null,
              questionRequestId: null,
              waitingOn: { kind: "run" },
              revision: task.revision + 1,
              acceptance: null,
              updatedAt: now,
              updatedBy: "server",
            });
            return false;
          }
          const id = `${workerThreadId}:question:${requestId}`;
          if (task.wake?.id === id) return false;
          const worker = yield* getShell(workerThreadId);
          yield* put({
            ...task,
            wake: pendingWake({
              id,
              reason: "question",
              revision: task.revision,
              runId: worker?.activeRunId ?? null,
              createdAt: now,
            }),
          });
          return true;
        }),
      );
      if (wakeNow) yield* deliverWake(workerThreadId);
    });

  const reevaluatePendingSettlements = store.listUnfinished().pipe(
    Effect.flatMap((tasks) =>
      Effect.forEach(
        tasks.filter((task) => task.settlement.state === "pending"),
        (task) => evaluateSettlement(task.workerThreadId),
        { discard: true },
      ),
    ),
  );

  const handle = (stored: OrchestrationV2StoredEvent) =>
    Effect.gen(function* () {
      const event = stored.event;
      if (event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status)) {
        // Restart reconciliation cancels runs a continuation resumes; that is not news.
        if (!String(stored.commandId).startsWith("command:runtime-reconcile:")) {
          yield* onRunEnded(event.threadId, event.payload.id, event.payload.status);
        }
        yield* evaluateSettlement(event.threadId);
        yield* reevaluatePendingSettlements;
        yield* reevaluateSettleRequests;
      } else if (event.type === "runtime-request.updated" && event.payload.kind === "user_input") {
        yield* onQuestion(event.threadId, event.payload.id, event.payload.status === "pending");
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread task reaction failed", {
              threadId: stored.event.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(handle);
  const seenSequence = yield* TxRef.make(-1);

  const recover: ThreadTaskService["Service"]["recover"] = Effect.gen(function* () {
    // Only unfinished deliveries and runs that ended unobserved; open tasks
    // with nothing new stay quiet.
    const unfinished = yield* store.listUnfinished();
    for (const task of unfinished) {
      if (task.wake?.state === "pending") yield* deliverWake(task.workerThreadId);
    }
    const open = yield* store.listVisible({ threadId: null, afterCursor: 0 });
    for (const task of open) {
      if (isAccepted(task) || task.settlement.state === "settled") continue;
      const records = yield* projections.getThreadRecords(task.workerThreadId, ["runs"]);
      const latest = records.runs.at(-1);
      // A run restart reconciliation cut and will continue is not news; the
      // continuation's own run reports when it ends.
      const continues =
        latest !== undefined &&
        Option.exists(
          yield* effectOutbox
            .get(`effect:restart-continuation:${latest.id}`)
            .pipe(Effect.orElseSucceed(() => Option.none())),
          (effect) => effect.status === "pending" || effect.status === "running",
        );
      if (
        latest !== undefined &&
        !continues &&
        latest.id !== task.observedRunId &&
        TERMINAL_RUN_STATUSES.has(latest.status)
      ) {
        yield* onRunEnded(task.workerThreadId, latest.id, latest.status);
      }
    }
    yield* reevaluatePendingSettlements;
    yield* reevaluateSettleRequests;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread task recovery failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start: ThreadTaskService["Service"]["start"] = Effect.fn("ThreadTaskService.start")(
    function* () {
      const after = yield* eventSink.latestSequence().pipe(Effect.orDie);
      yield* TxRef.set(seenSequence, after).pipe(Effect.tx);
      yield* forkParked(
        Stream.runForEach(eventSink.stream({ afterSequence: after }), (stored) =>
          (stored.event.type === "run.updated" || stored.event.type === "runtime-request.updated"
            ? worker.enqueue(stored)
            : Effect.void
          ).pipe(Effect.andThen(TxRef.set(seenSequence, stored.sequence).pipe(Effect.tx))),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread task event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  const drain: ThreadTaskService["Service"]["drain"] = Effect.gen(function* () {
    const target = yield* eventSink.latestSequence().pipe(Effect.orDie);
    yield* TxRef.get(seenSequence).pipe(
      Effect.tap((seen) => (seen < target ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );
    yield* worker.drain;
  });

  return ThreadTaskService.of({
    assign,
    assignLaunchedChild,
    read,
    update,
    watch,
    settleAfterTurn,
    authorizeMessage,
    recover,
    start,
    drain,
  });
});

export const layer = Layer.effect(ThreadTaskService, make).pipe(
  Layer.provide(ThreadTaskStore.layer),
);
