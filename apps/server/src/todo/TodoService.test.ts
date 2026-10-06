import { assert, describe, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, TodoId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TodoService from "./TodoService.ts";

const repoCheckout = ProjectId.make("project-repo-checkout");
const repoWorktree = ProjectId.make("project-repo-worktree");
const plainFolder = ProjectId.make("project-plain-folder");

// Both checkouts of acme/app resolve to one remote; the plain folder has none.
const identities = Layer.succeed(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  RepositoryIdentityResolver.RepositoryIdentityResolver.of({
    resolve: (cwd) =>
      Effect.succeed(
        cwd.startsWith("/repos/")
          ? {
              canonicalKey: "github.com/acme/app",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "git@github.com:acme/app.git",
              },
              rootPath: cwd,
              displayName: "acme/app",
            }
          : null,
      ),
  }),
);

const layer = TodoService.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(OrchestrationEventStore.layer),
  Layer.provideMerge(OrchestrationCommandReceipts.layer),
  Layer.provide(identities),
  Layer.provideMerge(Sqlite.layerMemory),
);

const seedProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`event-${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
  });

const seedProjects = Effect.all([
  seedProject(repoCheckout, "/repos/app"),
  seedProject(repoWorktree, "/repos/app-feature"),
  seedProject(plainFolder, "/folders/notes"),
]);

// Each case gets its own memory database.
const withTodos = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | TodoService.TodoService
    | ProjectStore.ProjectStoreV2
    | SqlClient.SqlClient
    | OrchestrationEventStore.OrchestrationEventStore
  >,
) => Effect.provide(effect, layer);

describe("TodoService", () => {
  it.effect("shares one list across checkouts of a repository and keeps folders separate", () =>
    withTodos(
      Effect.gen(function* () {
        yield* seedProjects;
        const todos = yield* TodoService.TodoService;

        const created = yield* todos.create({ projectId: repoCheckout, text: "Ship the popover" });
        yield* todos.create({ projectId: plainFolder, text: "Folder only" });

        const fromWorktree = yield* todos.list({ projectId: repoWorktree });
        assert.deepStrictEqual(fromWorktree.scope, {
          kind: "repository",
          key: "repo:github.com/acme/app",
          label: "acme/app",
        });
        assert.deepStrictEqual(
          fromWorktree.todos.map((todo) => todo.id),
          [created.id],
        );

        const fromFolder = yield* todos.list({ projectId: plainFolder });
        assert.strictEqual(fromFolder.scope.key, `project:${plainFolder}`);
        assert.deepStrictEqual(
          fromFolder.todos.map((todo) => todo.text),
          ["Folder only"],
        );

        const missing = yield* Effect.exit(
          todos.list({ projectId: ProjectId.make("project-missing") }),
        );
        assert.isTrue(Exit.isFailure(missing));
      }),
    ),
  );

  it.effect("settles like a thread: done, reversible, and repeats are silent no-ops", () =>
    withTodos(
      Effect.gen(function* () {
        yield* seedProjects;
        const todos = yield* TodoService.TodoService;
        const first = yield* todos.create({ projectId: plainFolder, text: "First" });
        const second = yield* todos.create({ projectId: plainFolder, text: "Second" });

        const settled = yield* todos.settle({ todoId: first.id });
        assert.isNotNull(settled.settledAt);
        const again = yield* todos.settle({ todoId: first.id });
        assert.strictEqual(again.settledAt, settled.settledAt);
        assert.strictEqual(again.updatedAt, settled.updatedAt);

        const afterSettle = yield* todos.list({ projectId: plainFolder });
        // Active todos lead; settled ones follow.
        assert.deepStrictEqual(
          afterSettle.todos.map((todo) => todo.id),
          [second.id, first.id],
        );
        assert.strictEqual(afterSettle.settledCount, 1);

        const unsettled = yield* todos.unsettle({ todoId: first.id });
        assert.isNull(unsettled.settledAt);
        const unsettledAgain = yield* todos.unsettle({ todoId: first.id });
        assert.strictEqual(unsettledAgain.updatedAt, unsettled.updatedAt);
        assert.strictEqual((yield* todos.list({ projectId: plainFolder })).settledCount, 0);
      }),
    ),
  );

  it.effect("records receipts so a retried command id returns its first result", () =>
    withTodos(
      Effect.gen(function* () {
        yield* seedProjects;
        const todos = yield* TodoService.TodoService;
        const sql = yield* SqlClient.SqlClient;
        const commandId = CommandId.make("command-create-once");

        const first = yield* todos.create({ projectId: plainFolder, text: "Once", commandId });
        const retried = yield* todos.create({ projectId: plainFolder, text: "Once", commandId });
        assert.strictEqual(retried.id, first.id);
        assert.strictEqual((yield* todos.list({ projectId: plainFolder })).todos.length, 1);

        const receipts = yield* sql<{
          readonly aggregate_kind: string;
          readonly aggregate_id: string;
          readonly status: string;
          readonly result_sequence: number;
        }>`
        SELECT aggregate_kind, aggregate_id, status, result_sequence
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `;
        const events = yield* sql<{ readonly sequence: number; readonly event_type: string }>`
        SELECT sequence, event_type
        FROM orchestration_events
        WHERE aggregate_kind = 'todo' AND stream_id = ${first.id}
      `;
        assert.deepStrictEqual(
          events.map((event) => event.event_type),
          ["todo.created"],
        );
        assert.deepStrictEqual(receipts, [
          {
            aggregate_kind: "todo",
            aggregate_id: first.id,
            status: "accepted",
            result_sequence: events[0]!.sequence,
          },
        ]);

        // A command id cannot be reused for a different command.
        const reused = yield* Effect.exit(todos.settle({ todoId: first.id, commandId }));
        assert.isTrue(Exit.isFailure(reused));
      }),
    ),
  );

  it.effect("removes a todo and rejects later commands as not found", () =>
    withTodos(
      Effect.gen(function* () {
        yield* seedProjects;
        const todos = yield* TodoService.TodoService;
        const todo = yield* todos.create({ projectId: plainFolder, text: "Remove me" });

        assert.deepStrictEqual(yield* todos.remove({ todoId: todo.id }), { todoId: todo.id });
        assert.strictEqual((yield* todos.list({ projectId: plainFolder })).todos.length, 0);

        const settle = yield* Effect.flip(todos.settle({ todoId: todo.id }));
        assert.strictEqual(settle._tag, "TodoNotFoundError");
        const unknown = yield* Effect.flip(
          todos.update({ todoId: TodoId.make("nope"), text: "x" }),
        );
        assert.strictEqual(unknown._tag, "TodoNotFoundError");
      }),
    ),
  );

  it.effect("streams the list to subscribers of any checkout after each change", () =>
    withTodos(
      Effect.scoped(
        Effect.gen(function* () {
          yield* seedProjects;
          const todos = yield* TodoService.TodoService;
          const pull = yield* Stream.toPull(todos.subscribe({ projectId: repoWorktree }));

          const initial = yield* pull;
          assert.deepStrictEqual(
            initial.map((list) => list.todos.length),
            [0],
          );

          // A change to another list must not wake this subscriber.
          yield* todos.create({ projectId: plainFolder, text: "Elsewhere" });
          const created = yield* todos.create({ projectId: repoCheckout, text: "Shared" });
          const next = yield* pull;
          assert.deepStrictEqual(
            next.map((list) => list.todos.map((todo) => todo.id)),
            [[created.id]],
          );
        }),
      ),
    ),
  );

  it.effect("keeps todo events out of application replay", () =>
    withTodos(
      Effect.gen(function* () {
        yield* seedProjects;
        const todos = yield* TodoService.TodoService;
        const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
        const before = yield* eventStore.latestApplicationSequence;
        yield* todos.create({ projectId: plainFolder, text: "Invisible to the shell" });
        assert.strictEqual(yield* eventStore.latestApplicationSequence, before);
      }),
    ),
  );
});
