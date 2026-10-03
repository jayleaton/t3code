import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "./SubagentProjection.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread parents"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "parent-thread" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("links chats under a parent, rejects cycles and missing parents, and detaches", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
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
    const setParent = (id: string, parentThreadId: string | null) =>
      orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`parent:${id}:${parentThreadId}`),
        threadId: ThreadId.make(id),
        parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
      });
    const parentOf = (id: string) =>
      projections
        .getThreadShell(ThreadId.make(id))
        .pipe(Effect.map((shell) => shell?.parentThreadId ?? null));

    yield* create("coordinator");
    yield* create("tests", "coordinator");
    yield* create("deps", "tests");
    assert.equal(yield* parentOf("deps"), "tests");

    const missing = yield* create("orphan", "nowhere").pipe(Effect.flip);
    assert.include(String(missing.cause), "Parent thread nowhere does not exist");
    const cycle = yield* setParent("coordinator", "deps").pipe(Effect.flip);
    assert.include(String(cycle.cause), "cannot be its own ancestor");
    assert.isNull(yield* parentOf("coordinator"));

    yield* setParent("deps", "coordinator");
    assert.equal(yield* parentOf("deps"), "coordinator");
    yield* setParent("deps", null);
    assert.isNull(yield* parentOf("deps"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("links chats under a parent on another environment and clears it on relink", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const remote = EnvironmentId.make("environment-pc");
    const linkOf = (id: string) =>
      projections.getThreadShell(ThreadId.make(id)).pipe(
        Effect.map((shell) => ({
          parentThreadId: shell?.parentThreadId ?? null,
          parentEnvironmentId: shell?.parentEnvironmentId ?? null,
        })),
      );
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:remote-child"),
      threadId: ThreadId.make("remote-child"),
      projectId: ProjectId.make("project:parents"),
      title: "remote-child",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      // The coordinating chat lives on the other machine, so this server cannot look it up.
      parentThreadId: ThreadId.make("pc-coordinator"),
      parentEnvironmentId: remote,
    });
    assert.deepEqual(yield* linkOf("remote-child"), {
      parentThreadId: ThreadId.make("pc-coordinator"),
      parentEnvironmentId: remote,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create:local-parent"),
      threadId: ThreadId.make("local-parent"),
      projectId: ProjectId.make("project:parents"),
      title: "local-parent",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("relink:remote-child"),
      threadId: ThreadId.make("remote-child"),
      parentThreadId: ThreadId.make("local-parent"),
    });
    assert.deepEqual(yield* linkOf("remote-child"), {
      parentThreadId: ThreadId.make("local-parent"),
      parentEnvironmentId: null,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "settling a chat settles idle sub-runs at every depth; unsettling returns only those",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const projections = yield* ProjectionStoreV2;
      const create = (id: string, parentThreadId?: string) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${id}`),
          threadId: ThreadId.make(id),
          projectId: ProjectId.make("project:parents"),
          title: id,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
          ...(parentThreadId === undefined
            ? {}
            : { parentThreadId: ThreadId.make(parentThreadId) }),
        });
      const settledAt = (id: string) =>
        projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledAt));

      yield* create("lead");
      yield* create("worker", "lead");
      yield* create("helper", "worker");
      yield* create("earlier", "lead");
      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:earlier"),
        threadId: ThreadId.make("earlier"),
      });
      const earlierAt = yield* settledAt("earlier");
      yield* TestClock.adjust("1 minute");

      yield* threads.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle:lead"),
        threadId: ThreadId.make("lead"),
      });
      const leadAt = yield* settledAt("lead");
      assert.isNotNull(leadAt);
      assert.deepEqual(yield* settledAt("worker"), leadAt);
      assert.deepEqual(yield* settledAt("helper"), leadAt);
      assert.deepEqual(yield* settledAt("earlier"), earlierAt);

      yield* threads.dispatch({
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle:lead"),
        threadId: ThreadId.make("lead"),
        reason: "user",
      });
      assert.isNull(yield* settledAt("lead"));
      assert.isNull(yield* settledAt("worker"));
      assert.isNull(yield* settledAt("helper"));
      assert.deepEqual(yield* settledAt("earlier"), earlierAt);
    }).pipe(Effect.provide(Layer.provideMerge(ThreadManagement.layer, testLayer))),
);

it("a sub-run nests under the chat that spawned it, not that chat's parent", () => {
  const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
  const parentThread = {
    id: ThreadId.make("spawner"),
    parentThreadId: ThreadId.make("spawner-parent"),
    parentEnvironmentId: EnvironmentId.make("environment-pc"),
    pinnedAt: now,
    autoSettleDisabledAt: now,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "spawner" },
  } as unknown as OrchestrationV2AppThread;
  const child = makeSubagentChildThread({
    parentThread,
    childThreadId: ThreadId.make("sub-run"),
    parentNodeId: NodeId.make("task"),
    activeProviderThreadId: null,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    title: "sub-run",
    now,
    createdBy: "agent",
    creationSource: "mcp",
  });
  assert.equal(child.parentThreadId, "spawner");
  assert.isNull(child.parentEnvironmentId);
  assert.isNull(child.pinnedAt);
  assert.isNull(child.autoSettleDisabledAt);
});

it.effect("an agent sub-run settles when its run completes and again after each reuse", () =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;
    const sink = yield* EventSinkV2;
    const create = (id: string, parentThreadId?: string) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${id}`),
        threadId: ThreadId.make(id),
        projectId: ProjectId.make("project:parents"),
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
    // Starts a run on the thread, which is what a parent re-sending to a sub-run does.
    const send = (id: string, turn: number) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${id}:${turn}`),
        threadId: ThreadId.make(id),
        messageId: MessageId.make(`message:${id}:${turn}`),
        text: `Task ${turn}`,
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    const completeLatestRun = (id: string) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(id);
        const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs.at(-1)!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:complete:${run.id}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
      });
    // Settling runs off the terminal-run worker; wait for its event, not a timer.
    const waitForSettled = (id: string, afterSequence: number) =>
      sink.stream({ afterSequence, eventType: "thread.settled" }).pipe(
        Stream.filter((stored) => stored.event.threadId === id),
        Stream.runHead,
      );
    const settledOverride = (id: string) =>
      projections.getThread(ThreadId.make(id)).pipe(Effect.map((thread) => thread.settledOverride));

    yield* create("orchestrator");
    yield* create("sub-run", "orchestrator");
    yield* send("orchestrator", 1);
    yield* send("sub-run", 1);

    let before = yield* sink.latestSequence();
    // The worker handles terminal runs in order, so once the sub-run settles
    // the top-level chat's earlier completion has been handled too.
    yield* completeLatestRun("orchestrator");
    yield* completeLatestRun("sub-run");
    yield* waitForSettled("sub-run", before);
    assert.equal(yield* settledOverride("sub-run"), "settled");
    assert.isNull(yield* settledOverride("orchestrator"));

    yield* send("sub-run", 2);
    assert.isNull(yield* settledOverride("sub-run"));

    before = yield* sink.latestSequence();
    yield* completeLatestRun("sub-run");
    yield* waitForSettled("sub-run", before);
    assert.equal(yield* settledOverride("sub-run"), "settled");
  }).pipe(Effect.provide(testLayer)),
);
