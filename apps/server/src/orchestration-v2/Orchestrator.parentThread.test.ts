import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, layer as projectionLayer } from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

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
