import * as Schema from "effect/Schema";

import { ApplicationEventMetadata } from "./applicationEvent.ts";
import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TodoId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const TODO_TEXT_MAX_CHARS = 500;
/** Settled todos returned with a list, newest first. Active todos are always returned in full. */
export const TODO_SETTLED_LIST_LIMIT = 50;

export const TodoText = TrimmedNonEmptyString.check(Schema.isMaxLength(TODO_TEXT_MAX_CHARS));

/**
 * The list a todo belongs to. A project whose checkout has a git remote shares
 * one list with every project and worktree of that repository on the
 * environment (`repo:<host>/<owner>/<repo>`); one without a remote keeps its
 * own (`project:<projectId>`).
 */
export const TodoScope = Schema.Struct({
  kind: Schema.Literals(["repository", "project"]),
  key: TrimmedNonEmptyString,
  /** `owner/repo` for a repository list, the project title otherwise. */
  label: Schema.String,
});
export type TodoScope = typeof TodoScope.Type;

/** A todo is active until settled. Settling is reversible; removing is not. */
export const Todo = Schema.Struct({
  id: TodoId,
  scopeKey: TrimmedNonEmptyString,
  text: TodoText,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
});
export type Todo = typeof Todo.Type;

export const TodoListInput = Schema.Struct({
  projectId: ProjectId,
});
export type TodoListInput = typeof TodoListInput.Type;

/**
 * Every active todo, oldest first, then up to `TODO_SETTLED_LIST_LIMIT` settled
 * todos, most recently settled first. `settledCount` counts all settled todos.
 */
export const TodoListResult = Schema.Struct({
  scope: TodoScope,
  todos: Schema.Array(Todo),
  settledCount: NonNegativeInt,
});
export type TodoListResult = typeof TodoListResult.Type;

export const TodoCreateInput = Schema.Struct({
  projectId: ProjectId,
  text: TodoText,
  /** Retrying with the same id returns the todo the first attempt created. */
  commandId: Schema.optional(CommandId),
});
export type TodoCreateInput = typeof TodoCreateInput.Type;

export const TodoUpdateInput = Schema.Struct({
  todoId: TodoId,
  text: TodoText,
  commandId: Schema.optional(CommandId),
});
export type TodoUpdateInput = typeof TodoUpdateInput.Type;

/** Shared by settle, unsettle, and remove. */
export const TodoTargetInput = Schema.Struct({
  todoId: TodoId,
  commandId: Schema.optional(CommandId),
});
export type TodoTargetInput = typeof TodoTargetInput.Type;

export const TodoMutationResult = Schema.Struct({
  todo: Todo,
});
export type TodoMutationResult = typeof TodoMutationResult.Type;

export const TodoRemoveResult = Schema.Struct({
  todoId: TodoId,
});
export type TodoRemoveResult = typeof TodoRemoveResult.Type;

export class TodoError extends Schema.TaggedError<TodoError>()("TodoError", {
  message: Schema.String,
  reason: Schema.Literals(["not-found", "failed"]),
  todoId: Schema.optional(TodoId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * EVENTS
 *
 * Todo events share the application event log with project and thread events
 * under aggregate kind `todo`. Payloads must stay decodable on replay.
 */
export const TodoCreatedPayload = Schema.Struct({
  todoId: TodoId,
  scopeKey: TrimmedNonEmptyString,
  text: TodoText,
  createdAt: IsoDateTime,
});

export const TodoUpdatedPayload = Schema.Struct({
  todoId: TodoId,
  text: TodoText,
  updatedAt: IsoDateTime,
});

export const TodoSettledPayload = Schema.Struct({
  todoId: TodoId,
  settledAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const TodoUnsettledPayload = Schema.Struct({
  todoId: TodoId,
  updatedAt: IsoDateTime,
});

export const TodoDeletedPayload = Schema.Struct({
  todoId: TodoId,
  deletedAt: IsoDateTime,
});

const TodoEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: Schema.Literal("todo"),
  aggregateId: TodoId,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: ApplicationEventMetadata,
} as const;

export const TodoEvent = Schema.Union([
  Schema.Struct({
    ...TodoEventBaseFields,
    type: Schema.Literal("todo.created"),
    payload: TodoCreatedPayload,
  }),
  Schema.Struct({
    ...TodoEventBaseFields,
    type: Schema.Literal("todo.updated"),
    payload: TodoUpdatedPayload,
  }),
  Schema.Struct({
    ...TodoEventBaseFields,
    type: Schema.Literal("todo.settled"),
    payload: TodoSettledPayload,
  }),
  Schema.Struct({
    ...TodoEventBaseFields,
    type: Schema.Literal("todo.unsettled"),
    payload: TodoUnsettledPayload,
  }),
  Schema.Struct({
    ...TodoEventBaseFields,
    type: Schema.Literal("todo.deleted"),
    payload: TodoDeletedPayload,
  }),
]);
export type TodoEvent = typeof TodoEvent.Type;
export type TodoEventType = TodoEvent["type"];
