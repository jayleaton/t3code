import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type ThreadId,
  threadParentRelationship,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

// A parent on another environment is out of reach of a local wake.
function localParentThreadId(thread: OrchestrationV2AppThread): ThreadId | null {
  return threadParentRelationship(thread) === "child"
    ? thread.parentEnvironmentId == null
      ? (thread.parentThreadId ?? null)
      : null
    : thread.lineage.parentThreadId;
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // `task` is undefined for a child chat from t3_thread_launch or create_threads.
  const wakeParent = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    child: Pick<OrchestrationV2AppThread, "id" | "title">,
    request: OrchestrationV2RuntimeRequest,
    task: OrchestrationV2Subagent | undefined,
  ) {
    const key = `${parentThreadId}:${request.id}`;
    const label = reportLabel(task === undefined ? child.title : task.title?.trim() || task.prompt);
    const subject = task === undefined ? `Child thread ${child.id}` : `Delegated task ${task.id}`;
    const situation =
      request.responseCapability.type === "message"
        ? `${subject} asked a question and is still working.`
        : `${subject} is blocked on a question and cannot continue until it is answered.`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:delegated-task-question:${key}`),
      threadId: parentThreadId,
      messageId: MessageId.make(`message:delegated-task-question:${key}`),
      text: `${situation} Read it with t3_pending_request action read, threadId ${child.id}, and requestId ${request.id}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
      notification: {
        source:
          task === undefined
            ? { kind: "subagent", childThreadId: child.id }
            : { kind: "delegated_task", taskIds: [task.id], childThreadId: child.id },
        outcome: "updated",
        summary: `${task === undefined ? "Child thread" : "Delegated task"}${label === undefined ? "" : ` "${label}"`} has a question`,
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  // The parent's message is the answer to its child's async questions, so they
  // close instead of lingering until a late answer starts a run that has nothing to do.
  const closeAnsweredQuestions = Effect.fnUntraced(function* (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "message.updated" }>,
  ) {
    const message = event.payload;
    if (message.role !== "user" || message.senderThreadId === undefined) return;
    const child = yield* projections.getThread(event.threadId);
    if (localParentThreadId(child) !== message.senderThreadId) return;
    const { runtimeRequests } = yield* projections.getThreadRecords(child.id, ["runtimeRequests"]);
    for (const request of runtimeRequests) {
      if (
        request.kind !== "user_input" ||
        request.status !== "pending" ||
        request.responseCapability.type !== "message" ||
        DateTime.isGreaterThan(request.createdAt, message.createdAt)
      ) {
        continue;
      }
      yield* engine
        .dispatch({
          type: "thread.user-input.dismiss",
          commandId: CommandId.make(`server:parent-answered-question:${child.id}:${request.id}`),
          threadId: child.id,
          requestId: request.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("closing a question the parent answered failed", {
              threadId: child.id,
              requestId: request.id,
              cause,
            }),
          ),
        );
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "message.updated") return yield* closeAnsweredQuestions(event);
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
          ]);
          for (const request of child.runtimeRequests) {
            if (
              request.kind !== "user_input" ||
              request.status !== "pending" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* wakeParent(task.threadId, child.thread, request, task).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const relationship = threadParentRelationship(child);
      const parentThreadId = localParentThreadId(child);
      if (parentThreadId === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      const key = `${parentThreadId}:${event.payload.id}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined) {
          yield* engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
            threadId: parentThreadId,
            runId: queued.id,
          });
        }
        return;
      }
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
      const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
      const run =
        runs.find((run) => run.id === event.runId) ??
        runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      const task = parent.subagents.find(
        (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
      );
      if (
        (task === undefined && relationship !== "child") ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      // A blocking delegate_task wait delivers the question itself.
      if (
        task?.completionWake === "settled_only" &&
        event.payload.responseCapability.type === "live" &&
        parent.runs.some(
          (run) =>
            run.id === task.runId &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* wakeParent(parentThreadId, child, request, task);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
