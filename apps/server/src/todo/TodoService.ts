import {
  CommandId,
  EventId,
  ProjectId,
  TODO_SETTLED_LIST_LIMIT,
  TodoId,
  type Todo,
  type TodoCreateInput,
  type TodoListResult,
  type TodoScope,
  type TodoTargetInput,
  type TodoUpdateInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  decodeTodoCommandRejection,
  encodeTodoCommandRejection,
  planTodoCommand,
  type TodoCommand,
} from "./TodoCommands.ts";
import * as TodoStore from "./TodoStore.ts";

export class TodoNotFoundError extends Schema.TaggedError<TodoNotFoundError>()(
  "TodoNotFoundError",
  { todoId: TodoId },
) {
  override get message(): string {
    return `Todo ${this.todoId} was not found.`;
  }
}

export class TodoProjectNotFoundError extends Schema.TaggedError<TodoProjectNotFoundError>()(
  "TodoProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class TodoOperationError extends Schema.TaggedError<TodoOperationError>()(
  "TodoOperationError",
  {
    operation: Schema.Literals(["resolve-scope", "read", "commit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Todo operation '${this.operation}' failed.`;
  }
}

export type TodoServiceError = TodoNotFoundError | TodoProjectNotFoundError | TodoOperationError;

/**
 * Todo lists shared by every project and worktree of one repository. Each
 * mutation is an event in the application log, folded into `projection_todos`
 * and receipted in the same transaction.
 */
export class TodoService extends Context.Service<
  TodoService,
  {
    readonly list: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<TodoListResult, TodoServiceError>;
    /** The project's list now, then again after every change to that list. */
    readonly subscribe: (input: {
      readonly projectId: ProjectId;
    }) => Stream.Stream<TodoListResult, TodoServiceError>;
    readonly create: (input: TodoCreateInput) => Effect.Effect<Todo, TodoServiceError>;
    readonly update: (input: TodoUpdateInput) => Effect.Effect<Todo, TodoServiceError>;
    readonly settle: (input: TodoTargetInput) => Effect.Effect<Todo, TodoServiceError>;
    readonly unsettle: (input: TodoTargetInput) => Effect.Effect<Todo, TodoServiceError>;
    readonly remove: (
      input: TodoTargetInput,
    ) => Effect.Effect<{ readonly todoId: TodoId }, TodoServiceError>;
  }
>()("t3/todo/TodoService") {}

const toTodo = (row: TodoStore.TodoRow): Todo => ({
  id: row.todoId,
  scopeKey: row.scopeKey,
  text: row.text,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  settledAt: row.settledAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore.OrchestrationEventStore;
  const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
  const store = yield* TodoStore.TodoStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const todoLocks = yield* KeyedLock.make<TodoId>();
  /** Scope keys whose list changed. */
  const changes = yield* PubSub.unbounded<string>();

  const readError = (cause: unknown) => new TodoOperationError({ operation: "read", cause });
  const commitError = (cause: unknown) => new TodoOperationError({ operation: "commit", cause });

  /** Repository identity follows the same remote preference as sidebar project grouping. */
  const resolveScope = Effect.fn("TodoService.resolveScope")(function* (projectId: ProjectId) {
    const project = yield* projects
      .get(projectId)
      .pipe(
        Effect.mapError((cause) => new TodoOperationError({ operation: "resolve-scope", cause })),
      );
    if (Option.isNone(project)) return yield* new TodoProjectNotFoundError({ projectId });
    const identity = yield* repositoryIdentities.resolve(project.value.workspaceRoot);
    return identity === null
      ? ({ kind: "project", key: `project:${projectId}`, label: project.value.title } as const)
      : ({
          kind: "repository",
          key: `repo:${identity.canonicalKey}`,
          label: identity.displayName ?? identity.canonicalKey,
        } as const);
  });

  const listScope = (scope: TodoScope) =>
    store.listByScope({ scopeKey: scope.key, settledLimit: TODO_SETTLED_LIST_LIMIT }).pipe(
      Effect.map(({ active, settled, settledCount }): TodoListResult => ({
        scope,
        todos: [...active, ...settled].map(toTodo),
        settledCount,
      })),
      Effect.mapError(readError),
    );

  const readTodo = (todoId: TodoId) =>
    store.get(todoId).pipe(
      Effect.mapError(readError),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new TodoNotFoundError({ todoId })),
          onSome: (row) =>
            row.deletedAt === null
              ? Effect.succeed(row)
              : Effect.fail(new TodoNotFoundError({ todoId })),
        }),
      ),
    );

  /**
   * Plan one command against the todo's row under its lock, then commit its
   * event or its rejection. A reused command id resolves to the receipt it
   * already has, so a retried create returns the todo the first attempt made.
   */
  const commit = Effect.fn("TodoService.commit")(function* (command: TodoCommand) {
    const planAndCommit = Effect.gen(function* () {
      const todo = Option.getOrUndefined(yield* store.get(command.todoId));
      const now = yield* DateTime.now;
      const acceptedAt = DateTime.formatIso(now);
      const planned = planTodoCommand({
        command,
        todo,
        eventId: EventId.make(yield* randomUuidV4),
        now,
      });
      const base = {
        commandId: command.commandId,
        aggregateKind: "todo" as const,
        aggregateId: command.todoId,
        commandType: command.type,
        acceptedAt,
      };
      const existingReceipt = receipts.getByCommandId({ commandId: command.commandId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail("The command receipt disappeared." as const),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (Result.isFailure(planned)) {
        const rejected = {
          ...base,
          resultSequence: yield* eventStore.latestApplicationSequence,
          status: "rejected" as const,
          error: encodeTodoCommandRejection(planned.failure),
        };
        const receipt = (yield* receipts.insertIfAbsent(rejected))
          ? rejected
          : yield* existingReceipt;
        return { receipt, scopeKey: undefined };
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const reserved = {
            ...base,
            resultSequence: 0,
            status: "accepted" as const,
            error: null,
          };
          if (!(yield* receipts.insertIfAbsent(reserved))) {
            return { receipt: yield* existingReceipt, scopeKey: undefined };
          }
          const event = yield* eventStore.appendTodoEvent(planned.success);
          yield* store.apply(event);
          const receipt = { ...reserved, resultSequence: event.sequence };
          yield* receipts.upsert(receipt);
          return {
            receipt,
            scopeKey: command.type === "todo.create" ? command.scopeKey : todo?.scopeKey,
          };
        }),
      );
    });

    const { receipt, scopeKey } = yield* todoLocks
      .withLock(command.todoId, planAndCommit)
      .pipe(Effect.mapError(commitError));
    if (scopeKey !== undefined) yield* PubSub.publish(changes, scopeKey);
    // A create retry carries a fresh todo id, so match it on kind and type only.
    if (
      receipt.aggregateKind !== "todo" ||
      receipt.commandType !== command.type ||
      (command.type !== "todo.create" && receipt.aggregateId !== command.todoId)
    ) {
      return yield* commitError(
        `Command ${command.commandId} was already used by ${receipt.commandType} for ${receipt.aggregateId}.`,
      );
    }
    const todoId = TodoId.make(receipt.aggregateId);
    if (receipt.status === "accepted") return todoId;
    const rejection = Option.getOrUndefined(decodeTodoCommandRejection(receipt.error));
    return yield* rejection?._tag === "TodoCommandMissingTodoError"
      ? new TodoNotFoundError({ todoId })
      : commitError(rejection ?? receipt.error ?? "The command was previously rejected.");
  });

  const commandIdFor = (commandId: CommandId | undefined) =>
    commandId === undefined
      ? randomUuidV4.pipe(Effect.map(CommandId.make))
      : Effect.succeed(commandId);

  const mutate = (type: "todo.settle" | "todo.unsettle", input: TodoTargetInput) =>
    Effect.gen(function* () {
      const todoId = yield* commit({
        type,
        todoId: input.todoId,
        commandId: yield* commandIdFor(input.commandId),
      });
      return toTodo(yield* readTodo(todoId));
    });

  return TodoService.of({
    list: Effect.fn("TodoService.list")(function* ({ projectId }) {
      return yield* listScope(yield* resolveScope(projectId));
    }),
    subscribe: ({ projectId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const scope = yield* resolveScope(projectId);
          // Subscribe before the first read so a change landing between the
          // two is buffered rather than dropped.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(listScope(scope)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((scopeKey) => scopeKey === scope.key),
              Stream.mapEffect(() => listScope(scope)),
            ),
          );
        }),
      ),
    create: Effect.fn("TodoService.create")(function* (input) {
      const scope = yield* resolveScope(input.projectId);
      const todoId = yield* commit({
        type: "todo.create",
        todoId: TodoId.make(yield* randomUuidV4),
        commandId: yield* commandIdFor(input.commandId),
        scopeKey: scope.key,
        text: input.text,
      });
      return toTodo(yield* readTodo(todoId));
    }),
    update: Effect.fn("TodoService.update")(function* (input) {
      const todoId = yield* commit({
        type: "todo.update",
        todoId: input.todoId,
        commandId: yield* commandIdFor(input.commandId),
        text: input.text,
      });
      return toTodo(yield* readTodo(todoId));
    }),
    settle: (input) => mutate("todo.settle", input),
    unsettle: (input) => mutate("todo.unsettle", input),
    remove: Effect.fn("TodoService.remove")(function* (input) {
      const todoId = yield* commit({
        type: "todo.delete",
        todoId: input.todoId,
        commandId: yield* commandIdFor(input.commandId),
      });
      return { todoId };
    }),
  });
});

export const layer = Layer.effect(TodoService, make).pipe(Layer.provide(TodoStore.layer));
