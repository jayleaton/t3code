import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  layer as projectionLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadTaskService from "./ThreadTaskService.ts";
import * as ThreadTaskStore from "./ThreadTaskStore.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread tasks"),
} as ProviderAdapterV2Shape;
const database = Sqlite.layerMemory;
const runtime = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-tasks" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const testLayer = Layer.mergeAll(runtime, ThreadTaskStore.layer.pipe(Layer.provide(database))).pipe(
  Layer.provideMerge(runtime),
);

/** A fresh service over the same database, as after a server restart. */
const makeService = ThreadTaskService.make.pipe(
  Effect.provide(ThreadTaskStore.layer.pipe(Layer.provide(database))),
);

const owner = { kind: "thread", threadId: ThreadId.make("captain") } as const;
const worker = { kind: "thread", threadId: ThreadId.make("worker") } as const;
const stranger = { kind: "thread", threadId: ThreadId.make("stranger") } as const;

const fixture = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const sink = yield* EventSinkV2;
  const create = (id: string, parentThreadId?: string) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project:tasks"),
      title: id,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
    });
  const send = (id: string, turn: number) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${id}:${turn}`),
      threadId: ThreadId.make(id),
      messageId: MessageId.make(`message:${id}:${turn}`),
      text: `Turn ${turn}`,
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "agent",
      creationSource: "mcp",
    });
  const endLatestRun = (id: string, status: "completed" | "failed" = "completed") =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(id);
      const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:end:${run.id}`),
            type: "run.updated",
            threadId,
            runId: run.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status, completedAt: now },
          },
        ],
      });
      return run.id;
    });
  /** Ends every unfinished run, including queued wakes. */
  const endOpenRuns = (id: string) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(id);
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: runs
          .filter(
            (run) => !["completed", "failed", "interrupted", "cancelled"].includes(run.status),
          )
          .map((run) => ({
            id: EventId.make(`event:end-open:${run.id}`),
            type: "run.updated" as const,
            threadId,
            runId: run.id,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: { ...run, status: "completed" as const, completedAt: now },
          })),
      });
    });
  const question = (id: string, requestId: string, status: "pending" | "resolved") =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:question:${requestId}:${status}`),
            type: "runtime-request.updated",
            threadId: ThreadId.make(id),
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make(requestId),
              nodeId: NodeId.make(`node:${requestId}`),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status,
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: status === "pending" ? null : now,
            },
          },
        ],
      });
    });
  /** Server wake messages queued on a thread, oldest first. */
  const wakes = (id: string) =>
    projections
      .getThreadRecords(ThreadId.make(id), ["messages"], { messageRoles: ["user"] })
      .pipe(
        Effect.map(({ messages }) =>
          messages
            .filter((message) => String(message.id).startsWith("message:thread-task-wake:"))
            .map((message) => ({ id: String(message.id), text: message.text })),
        ),
      );
  const settled = (id: string) =>
    projections
      .getThread(ThreadId.make(id))
      .pipe(Effect.map((thread) => thread.settledOverride === "settled"));
  return {
    orchestrator,
    projections,
    sink,
    create,
    send,
    endLatestRun,
    endOpenRuns,
    question,
    wakes,
    settled,
  };
});

it.effect(
  "workers report INPUT and DONE; owners accept; strangers and stale writes are refused",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const tasks = yield* makeService;
        yield* tasks.start();
        yield* f.create("captain");
        yield* f.create("worker", "captain");
        yield* f.create("stranger");
        yield* f.send("worker", 1);

        // Only the parent assigns, and only to a child chat.
        const denied = yield* tasks
          .assign(stranger, { threadId: worker.threadId, summary: "Ship it" })
          .pipe(Effect.flip);
        assert.equal(denied.code, "scope_denied");
        const assigned = yield* tasks.assign(owner, {
          threadId: worker.threadId,
          summary: "Ship the pipeline",
          settleWhenAccepted: true,
        });
        assert.equal(assigned.task.status, "WAITING");
        assert.isTrue(assigned.continuationLive);
        assert.equal(assigned.workerRun, "running");

        // Wrong parent cannot read or write; a stale revision is rejected.
        assert.equal(
          (yield* tasks.read(stranger, { threadId: worker.threadId }).pipe(Effect.flip)).code,
          "scope_denied",
        );
        const conflict = yield* tasks
          .update(worker, { expectedRevision: 7, summary: "x" })
          .pipe(Effect.flip);
        assert.equal(conflict.code, "revision_conflict");
        assert.equal(conflict.currentRevision, 1);

        // INPUT must name the missing decision; then it wakes the owner once.
        assert.equal(
          (yield* tasks.update(worker, { expectedRevision: 1, status: "INPUT" }).pipe(Effect.flip))
            .code,
          "invalid_transition",
        );
        const input = yield* tasks.update(worker, {
          expectedRevision: 1,
          status: "INPUT",
          needs: "Which provider should the analyst use?",
          clientRequestId: "input-1",
        });
        assert.equal(input.task.revision, 2);
        assert.equal(input.task.wake?.state, "delivered");
        const retried = yield* tasks.update(worker, {
          expectedRevision: 1,
          status: "INPUT",
          needs: "Which provider should the analyst use?",
          clientRequestId: "input-1",
        });
        assert.equal(retried.task.revision, 2);
        // Summary churn does not wake; owner writes never wake.
        yield* tasks.update(worker, { expectedRevision: 2, summary: "Still blocked on provider" });
        yield* tasks.update(owner, {
          threadId: worker.threadId,
          expectedRevision: 3,
          needs: "Provider choice, asked JJ",
        });
        let wakes = yield* f.wakes("captain");
        assert.equal(wakes.length, 1);
        assert.include(wakes[0]!.text, "Which provider");

        // Worker cannot accept or grant consent.
        assert.equal(
          (yield* tasks.update(worker, { expectedRevision: 4, accept: true }).pipe(Effect.flip))
            .code,
          "scope_denied",
        );
        // DONE needs evidence.
        assert.equal(
          (yield* tasks.update(worker, { expectedRevision: 4, status: "DONE" }).pipe(Effect.flip))
            .code,
          "invalid_transition",
        );
        const done = yield* tasks.update(worker, {
          expectedRevision: 4,
          status: "DONE",
          evidence: ["PR #12 open at abc123, focused tests green"],
        });
        assert.equal(done.task.status, "DONE");
        assert.isFalse(done.accepted);
        wakes = yield* f.wakes("captain");
        assert.equal(wakes.length, 2);
        assert.include(wakes[1]!.text, "reports DONE");

        // DONE plus standing consent does not settle an unaccepted deliverable.
        yield* f.endLatestRun("worker");
        yield* tasks.drain;
        assert.isFalse(yield* f.settled("worker"));
        const unaccepted = (yield* tasks.read(owner, { threadId: worker.threadId })).tasks[0]!;
        assert.equal(unaccepted.task.settlement.blockedBy, "not_accepted");
        // The run that raised DONE does not wake the owner a second time.
        assert.equal((yield* f.wakes("captain")).length, 2);

        // Owner acceptance of that exact revision settles the idle worker.
        const accepted = yield* tasks.update(owner, {
          threadId: worker.threadId,
          expectedRevision: 5,
          accept: true,
        });
        assert.isTrue(accepted.accepted);
        assert.equal(accepted.task.settlement.state, "settled");
        assert.isTrue(yield* f.settled("worker"));
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("acceptance waits for the worker's turn and descendants, and reopening clears it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* tasks.start();
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.create("helper", "worker");
      yield* f.send("worker", 1);
      yield* tasks.assign(owner, {
        threadId: worker.threadId,
        summary: "Integrate",
        settleWhenAccepted: true,
      });
      yield* f.send("helper", 1);
      yield* tasks.assign(worker, { threadId: ThreadId.make("helper"), summary: "Commit" });

      // A child task the worker has not accepted blocks DONE.
      const blocked = yield* tasks
        .update(worker, { expectedRevision: 1, status: "DONE", evidence: ["Merged"] })
        .pipe(Effect.flip);
      assert.equal(blocked.code, "pending_descendant");
      const helper = { kind: "thread", threadId: ThreadId.make("helper") } as const;
      yield* tasks.update(helper, { expectedRevision: 1, status: "DONE", evidence: ["sha 1"] });
      yield* tasks.update(worker, {
        threadId: helper.threadId,
        expectedRevision: 2,
        accept: true,
      });
      yield* tasks.update(worker, { expectedRevision: 1, status: "DONE", evidence: ["Merged"] });

      // Reopening clears acceptance; accepting a stale revision is refused.
      yield* tasks.update(owner, { threadId: worker.threadId, expectedRevision: 2, accept: true });
      const reopened = yield* tasks.update(owner, {
        threadId: worker.threadId,
        expectedRevision: 2,
        status: "WAITING",
        summary: "Integrate plus docs",
      });
      assert.isNull(reopened.task.acceptance);
      assert.equal(reopened.task.settlement.state, "none");
      yield* tasks.update(worker, { expectedRevision: 3, status: "DONE", evidence: ["Docs too"] });
      assert.equal(
        (yield* tasks
          .update(owner, { threadId: worker.threadId, expectedRevision: 3, accept: true })
          .pipe(Effect.flip)).code,
        "revision_conflict",
      );

      // Accepted while its turn is still going: settlement waits for the turn.
      const pending = yield* tasks.update(owner, {
        threadId: worker.threadId,
        expectedRevision: 4,
        accept: true,
      });
      assert.equal(pending.task.settlement.state, "pending");
      assert.equal(pending.task.settlement.blockedBy, "active_run");
      assert.isFalse(yield* f.settled("worker"));

      // The worker's turns end (including the helper's DONE wake) but its helper still runs.
      yield* f.endOpenRuns("worker");
      yield* tasks.drain;
      const descendant = (yield* tasks.read(owner, { threadId: worker.threadId })).tasks[0]!;
      assert.equal(descendant.task.settlement.blockedBy, "pending_descendant");
      assert.isFalse(yield* f.settled("worker"));

      // Once the helper's turn ends the accepted tree settles.
      yield* f.endLatestRun("helper");
      yield* tasks.drain;
      assert.isTrue(yield* f.settled("worker"));
      assert.isTrue(yield* f.settled("helper"));
      assert.equal(
        (yield* tasks.read(owner, { threadId: worker.threadId })).tasks[0]!.task.settlement.state,
        "settled",
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("every follow-up turn and question wakes the owner once; answers clear INPUT", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* tasks.start();
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.send("worker", 1);
      yield* tasks.assign(owner, { threadId: worker.threadId, summary: "Fix the bug" });

      yield* f.endLatestRun("worker", "failed");
      yield* tasks.drain;
      let wakes = yield* f.wakes("captain");
      assert.equal(wakes.length, 1);
      assert.include(wakes[0]!.text, "turn failed");
      assert.include(wakes[0]!.text, "A finished turn is not a finished task");

      // A later follow-up run reports again, and only once.
      yield* f.send("worker", 2);
      const runId = yield* f.endLatestRun("worker");
      yield* tasks.drain;
      wakes = yield* f.wakes("captain");
      assert.equal(wakes.length, 2);
      assert.include(wakes[1]!.id, String(runId));

      // A question wakes the owner; answering it clears the stale INPUT.
      yield* f.send("worker", 3);
      yield* f.question("worker", "request:q1", "pending");
      yield* tasks.drain;
      assert.equal((yield* f.wakes("captain")).length, 3);
      const read = (yield* tasks.read(worker, {})).tasks.find(
        (view) => view.task.workerThreadId === worker.threadId,
      )!;
      yield* tasks.update(worker, {
        expectedRevision: read.task.revision,
        status: "INPUT",
        needs: "Answer to the scope question",
        questionRequestId: RuntimeRequestId.make("request:q1"),
      });
      yield* f.question("worker", "request:q1", "resolved");
      yield* tasks.drain;
      const answered = (yield* tasks.read(owner, { threadId: worker.threadId })).tasks[0]!;
      assert.equal(answered.task.status, "WAITING");
      assert.isNull(answered.task.questionRequestId);
      assert.isNull(answered.task.needs);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("restart replays only unfinished wakes and unobserved turns, exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const store = yield* ThreadTaskStore.ThreadTaskStore;
      const first = yield* makeService;
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.create("quiet", "captain");
      yield* f.send("worker", 1);
      yield* f.send("quiet", 1);
      yield* first.assign(owner, { threadId: worker.threadId, summary: "Crash mid-wake" });
      yield* first.assign(owner, { threadId: ThreadId.make("quiet"), summary: "Nothing new" });

      // The server stopped after committing a DONE but before queuing its wake,
      // and while the worker's turn ended unobserved.
      const task: ThreadTask = Option.getOrThrow(yield* store.get(worker.threadId));
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* store.put({
        ...task,
        status: "DONE",
        evidence: ["sha 1"],
        waitingOn: null,
        revision: 2,
        wake: {
          id: `${worker.threadId}:revision:2:done`,
          reason: "done",
          revision: 2,
          runId: null,
          state: "pending",
          skipReason: null,
          createdAt: now,
        },
      });
      yield* f.endLatestRun("worker");

      const restarted = yield* makeService;
      yield* restarted.recover;
      yield* restarted.recover;
      const wakes = yield* f.wakes("captain");
      assert.deepEqual(
        wakes.map((wake) => wake.id).sort(),
        [
          `message:thread-task-wake:${worker.threadId}:revision:2:done`,
          `message:thread-task-wake:${worker.threadId}:run:${(yield* f.projections.getThreadRecords(worker.threadId, ["runs"])).runs.at(-1)!.id}`,
        ].sort(),
      );
      const recovered = (yield* restarted.read(owner, { threadId: worker.threadId })).tasks[0]!;
      assert.equal(recovered.task.wake?.state, "delivered");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("a settled owner is not woken and its worker reports no live continuation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* tasks.start();
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.send("worker", 1);
      yield* tasks.assign(owner, { threadId: worker.threadId, summary: "Keep going" });
      yield* f.orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:captain"),
        threadId: owner.threadId,
      });
      yield* f.endLatestRun("worker").pipe(Effect.ignore);
      yield* tasks.drain;
      const view = (yield* tasks.read(worker, {})).tasks[0]!;
      assert.equal(view.task.wake?.state, "skipped");
      assert.equal(view.task.wake?.skipReason, "owner_settled");
      assert.isFalse(view.continuationLive);
      assert.equal((yield* f.wakes("captain")).length, 0);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.live("watch returns on the next change and times out without one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.send("worker", 1);
      const initial = yield* tasks.watch(owner, {});
      const waiting = yield* tasks
        .watch(owner, { afterCursor: initial.cursor, timeoutMs: 60_000 })
        .pipe(Effect.forkScoped);
      yield* tasks.assign(owner, { threadId: worker.threadId, summary: "Watch me" });
      const changed = yield* Fiber.join(waiting);
      assert.isFalse(changed.timedOut);
      assert.equal(changed.tasks[0]?.task.summary, "Watch me");
      const quiet = yield* tasks.watch(owner, { afterCursor: changed.cursor, timeoutMs: 1 });
      assert.isTrue(quiet.timedOut);
      assert.equal(quiet.cursor, changed.cursor);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("a captain settles itself after its turn once its children are accepted and quiet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* tasks.start();
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.create("stranger");
      yield* f.send("captain", 1);
      yield* f.send("worker", 1);
      yield* tasks.assign(owner, { threadId: worker.threadId, summary: "Last deliverable" });

      // Only the chat itself may ask; while its own turn runs it waits.
      assert.equal(
        (yield* tasks.settleAfterTurn(stranger, { threadId: owner.threadId }).pipe(Effect.flip))
          .code,
        "scope_denied",
      );
      const requested = yield* tasks.settleAfterTurn(owner, {});
      assert.equal(requested.state, "pending");
      assert.equal(requested.blockedBy, "active_run");
      assert.equal(requested.requestedBy, "self");

      // Its turn ends, but the child's task is not accepted yet.
      yield* f.endOpenRuns("captain");
      yield* tasks.drain;
      let current = yield* tasks.settleAfterTurn(owner, {});
      assert.equal(current.blockedBy, "open_task");
      assert.isFalse(yield* f.settled("captain"));

      // Accepted, but the child's own turn is still running.
      yield* tasks.update(worker, { expectedRevision: 1, status: "DONE", evidence: ["Merged"] });
      yield* f.endOpenRuns("captain");
      yield* tasks.drain;
      yield* tasks.update(owner, { threadId: worker.threadId, expectedRevision: 2, accept: true });
      current = yield* tasks.settleAfterTurn(owner, {});
      assert.equal(current.blockedBy, "pending_descendant");
      assert.isFalse(yield* f.settled("captain"));

      // The child's turn ends: the captain and its accepted child settle together.
      yield* f.endOpenRuns("worker");
      yield* tasks.drain;
      current = yield* tasks.settleAfterTurn(owner, {});
      assert.equal(current.state, "settled");
      assert.isTrue(yield* f.settled("captain"));
      assert.isTrue(yield* f.settled("worker"));
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("a pinned chat is held and a withdrawn request never settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* tasks.start();
      yield* f.create("captain");
      yield* f.send("captain", 1);
      yield* f.orchestrator.dispatch({
        type: "thread.pin",
        commandId: CommandId.make("pin:captain"),
        threadId: owner.threadId,
      });
      const held = yield* tasks.settleAfterTurn(owner, {});
      assert.equal(held.blockedBy, "held");
      const cancelled = yield* tasks.settleAfterTurn(owner, { cancel: true });
      assert.equal(cancelled.state, "cancelled");
      yield* f.orchestrator.dispatch({
        type: "thread.unpin",
        commandId: CommandId.make("unpin:captain"),
        threadId: owner.threadId,
      });
      yield* f.endOpenRuns("captain");
      yield* tasks.drain;
      assert.isFalse(yield* f.settled("captain"));
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("a pull request watch counts only while its thread is live", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const tasks = yield* makeService;
      yield* f.create("captain");
      yield* f.create("worker", "captain");
      yield* f.send("worker", 1);
      yield* tasks.assign(owner, { threadId: worker.threadId, summary: "Wait for CI" });
      const pullRequest = { host: "github.com", repository: "jayleaton/t3code", number: 7 };
      yield* f.orchestrator.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch:captain"),
        threadId: owner.threadId,
        ...pullRequest,
        watching: true,
        link: { url: "https://github.com/jayleaton/t3code/pull/7", source: "manual" },
      });
      const waitOnPullRequest = (expectedRevision: number) =>
        tasks.update(worker, {
          expectedRevision,
          status: "WAITING",
          waitingOn: { kind: "pull_request", repository: "jayleaton/t3code", number: 7 },
        });

      // The owner's watch is registered but parked while the owner is settled.
      yield* f.orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:captain"),
        threadId: owner.threadId,
      });
      assert.equal((yield* waitOnPullRequest(1).pipe(Effect.flip)).code, "continuation_missing");

      // Active again, the same watch is a live continuation.
      yield* f.orchestrator.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:captain"),
        threadId: owner.threadId,
        reason: "user",
      });
      const waiting = yield* waitOnPullRequest(1);
      assert.isTrue(waiting.continuationLive);

      // Archiving the only watcher makes the stored continuation dead on read.
      yield* f.orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive:captain"),
        threadId: owner.threadId,
      });
      const archived = (yield* tasks.read(worker, {})).tasks[0]!;
      assert.equal(archived.task.waitingOn?.kind, "pull_request");
      assert.isFalse(archived.continuationLive);
    }),
  ).pipe(Effect.provide(testLayer)),
);
