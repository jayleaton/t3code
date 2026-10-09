import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadProfileSnapshot,
  ThreadId,
  threadParentRelationship,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for parent relationships"),
} as ProviderAdapterV2Shape;
const database = Sqlite.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  projectionLayer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "parent-relationship" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const profile = (profileId: string): ThreadProfileSnapshot => ({
  profileId,
  profileName: profileId,
  revision: 1,
  effectiveSource: {
    modelSelection: "profile",
    runtimeMode: "profile",
    interactionMode: "profile",
    reasoningEffort: "profile",
  },
});

const harness = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const sink = yield* EventSinkV2;
  const create = (id: string, options: { parent?: string; profileId?: string } = {}) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project:relationships"),
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "agent",
      creationSource: "mcp",
      ...(options.parent === undefined ? {} : { parentThreadId: ThreadId.make(options.parent) }),
      ...(options.profileId === undefined ? {} : { profileSnapshot: profile(options.profileId) }),
    });
  const setParent = (id: string, parent: string | null, suffix = "") =>
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(`parent:${id}:${parent}${suffix}`),
      threadId: ThreadId.make(id),
      parentThreadId: parent === null ? null : ThreadId.make(parent),
    });
  const thread = (id: string) => projections.getThread(ThreadId.make(id));
  const kindOf = (id: string) =>
    projections
      .getThreadShell(ThreadId.make(id))
      .pipe(Effect.map((shell) => (shell === null ? "missing" : threadParentRelationship(shell))));
  /** Writes a thread directly, as an older server would have stored it. */
  const writeLegacy = (row: OrchestrationV2AppThread) =>
    Effect.gen(function* () {
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:legacy:${row.id}`),
            type: "thread.created",
            threadId: row.id,
            providerInstanceId: instanceId,
            occurredAt: yield* DateTime.now,
            payload: row,
          },
        ],
      });
    });
  /** A task-spawned thread as stored before the kind was recorded. */
  const legacySpawned = (input: {
    id: string;
    owner: string;
    parent?: string | null;
    profileId?: string;
    creationSource?: "mcp" | "provider";
  }) =>
    Effect.gen(function* () {
      const owner = yield* thread(input.owner);
      const { parentRelationship: _kind, ...spawned } = makeSubagentChildThread({
        parentThread: owner,
        childThreadId: ThreadId.make(input.id),
        parentNodeId: NodeId.make(`node:${input.id}`),
        activeProviderThreadId: null,
        providerInstanceId: instanceId,
        modelSelection,
        title: input.id,
        now: yield* DateTime.now,
        createdBy: "agent",
        creationSource: input.creationSource ?? "mcp",
      });
      yield* writeLegacy({
        ...spawned,
        ...(input.parent === undefined
          ? {}
          : { parentThreadId: input.parent === null ? null : ThreadId.make(input.parent) }),
        ...(input.profileId === undefined ? {} : { profileSnapshot: profile(input.profileId) }),
      });
    });
  return { orchestrator, projections, create, setParent, thread, kindOf, legacySpawned };
});

it.effect("chats created under a parent are children; detaching makes them top-level", () =>
  Effect.gen(function* () {
    const { create, setParent, thread, kindOf } = yield* harness;
    yield* create("captain", { profileId: "captain" });
    yield* create("doug", { parent: "captain", profileId: "doug" });
    yield* create("standalone");

    assert.equal((yield* thread("doug")).parentRelationship, "child");
    assert.equal(yield* kindOf("doug"), "child");
    assert.isUndefined((yield* thread("standalone")).parentRelationship);
    assert.isNull(yield* kindOf("standalone"));

    // Drag to parent / t3_set_thread_parent.
    yield* setParent("standalone", "captain");
    assert.equal(yield* kindOf("standalone"), "child");
    // Remove from parent.
    yield* setParent("doug", null);
    assert.isNull((yield* thread("doug")).parentRelationship);
    assert.isNull(yield* kindOf("doug"));
    yield* setParent("doug", "captain", ":again");
    assert.equal(yield* kindOf("doug"), "child");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a delegate_task run as a named agent is a movable child; a profile-less helper is a subagent",
  () =>
    Effect.gen(function* () {
      const { orchestrator, projections, create, setParent, thread, kindOf } = yield* harness;
      yield* create("captain", { profileId: "captain" });
      yield* create("elsewhere");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:captain"),
        threadId: ThreadId.make("captain"),
        messageId: MessageId.make("message:captain"),
        text: "Coordinate the feature",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* projections.getThreadRecords(ThreadId.make("captain"), ["runs"])).runs.at(
        -1,
      )!;
      const delegate = (suffix: string, profileId?: string) =>
        orchestrator
          .dispatch({
            type: "delegated_task.request",
            commandId: CommandId.make(`delegate:${suffix}`),
            parentThreadId: ThreadId.make("captain"),
            parentRunId: run.id,
            parentNodeId: run.rootNodeId!,
            task: `Task ${suffix}`,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
            ...(profileId === undefined ? {} : { profileSnapshot: profile(profileId) }),
          })
          .pipe(
            Effect.map(
              (result) =>
                result.storedEvents.find((stored) => stored.event.type === "thread.created")!.event
                  .threadId,
            ),
          );

      const review = yield* delegate("review", "randy");
      const helper = yield* delegate("helper");
      assert.equal(yield* kindOf(review), "child");
      assert.equal(yield* kindOf(helper), "subagent");
      // Both keep the task lineage that returns their result to the delegator.
      assert.equal((yield* thread(review)).lineage.relationshipToParent, "subagent");
      assert.equal((yield* thread(helper)).lineage.relationshipToParent, "subagent");
      assert.equal((yield* thread(review)).parentThreadId, "captain");
      assert.equal((yield* thread(helper)).parentThreadId, "captain");

      // A child can be nested elsewhere; a subagent stays with its owner.
      yield* setParent(review, "elsewhere");
      assert.equal((yield* thread(review)).parentThreadId, "elsewhere");
      assert.equal(yield* kindOf(review), "child");
      const rejected = yield* setParent(helper, "elsewhere").pipe(Effect.flip);
      assert.include(String(rejected.cause), "only child chats can move");
      assert.equal((yield* thread(helper)).parentThreadId, "captain");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("startup repair records the kind of legacy rows and keeps every thread visible", () =>
  Effect.gen(function* () {
    const { orchestrator, create, thread, kindOf, legacySpawned } = yield* harness;
    yield* create("captain", { profileId: "captain" });
    yield* create("dragged-to");
    // delegate_task as Randy from Captain: a named agent, so a child.
    yield* legacySpawned({ id: "randy-review", owner: "captain", profileId: "randy" });
    // delegate_task without a profile inherits Captain's: a helper.
    yield* legacySpawned({ id: "helper", owner: "captain" });
    // Stored before subagents carried a top-level owner.
    yield* legacySpawned({ id: "pointerless", owner: "captain", parent: null });
    // The Claude Agent tool, even with an inherited profile.
    yield* legacySpawned({ id: "native", owner: "captain", creationSource: "provider" });
    // Moved under another chat before subagents were locked: nesting is a child.
    yield* legacySpawned({ id: "moved", owner: "captain", parent: "dragged-to" });
    // Owner since deleted: no Lineage left to appear in. Deleting an owner
    // detaches the subagents that point at it at once; older rows without the
    // pointer are left for startup.
    yield* create("gone");
    yield* legacySpawned({ id: "detached", owner: "gone" });
    yield* legacySpawned({ id: "orphan", owner: "gone", parent: null });
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:gone"),
      threadId: ThreadId.make("gone"),
    });
    assert.isNull(yield* kindOf("detached"));
    // A plain legacy child reads correctly through the fallback and is left alone.
    yield* create("plain-child", { parent: "captain" });

    assert.equal(yield* kindOf("randy-review"), "subagent");
    const repaired = yield* orchestrator.repairThreadParents;
    assert.deepEqual(
      [...repaired].toSorted(),
      ["helper", "moved", "native", "orphan", "pointerless", "randy-review"].map((id) =>
        ThreadId.make(id),
      ),
    );

    assert.equal(yield* kindOf("randy-review"), "child");
    assert.equal((yield* thread("randy-review")).parentThreadId, "captain");
    assert.equal(yield* kindOf("helper"), "subagent");
    assert.equal(yield* kindOf("native"), "subagent");
    assert.equal(yield* kindOf("pointerless"), "subagent");
    assert.equal((yield* thread("pointerless")).parentThreadId, "captain");
    assert.equal(yield* kindOf("moved"), "child");
    assert.equal((yield* thread("moved")).parentThreadId, "dragged-to");
    assert.isNull(yield* kindOf("orphan"));
    assert.isNull((yield* thread("orphan")).parentThreadId ?? null);
    assert.equal(yield* kindOf("plain-child"), "child");
    // Idempotent: a second start finds nothing to do.
    assert.deepEqual(yield* orchestrator.repairThreadParents, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("settling a parent settles its children and its subagents; unsettle returns both", () =>
  Effect.gen(function* () {
    const { create, thread, legacySpawned, orchestrator } = yield* harness;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* create("captain", { profileId: "captain" });
    yield* create("doug", { parent: "captain", profileId: "doug" });
    yield* legacySpawned({ id: "helper", owner: "captain" });
    yield* orchestrator.repairThreadParents;
    const settledAt = (id: string) => thread(id).pipe(Effect.map((row) => row.settledAt));

    yield* threads.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("settle:captain"),
      threadId: ThreadId.make("captain"),
    });
    const captainAt = yield* settledAt("captain");
    assert.isNotNull(captainAt);
    assert.deepEqual(yield* settledAt("doug"), captainAt);
    assert.deepEqual(yield* settledAt("helper"), captainAt);

    yield* threads.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle:captain"),
      threadId: ThreadId.make("captain"),
      reason: "user",
    });
    assert.isNull(yield* settledAt("doug"));
    assert.isNull(yield* settledAt("helper"));
  }).pipe(Effect.provide(Layer.provideMerge(ThreadManagement.layer, testLayer))),
);
