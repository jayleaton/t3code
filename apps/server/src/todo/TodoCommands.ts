import { type CommandId, type EventId, TodoId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { UnsequencedTodoEvent } from "../persistence/OrchestrationEventStore.ts";
import type { TodoRow } from "./TodoStore.ts";

interface TodoCommandBase {
  readonly commandId: CommandId;
  readonly todoId: TodoId;
}

export type TodoCommand =
  | (TodoCommandBase & {
      readonly type: "todo.create";
      readonly scopeKey: string;
      readonly text: string;
    })
  | (TodoCommandBase & { readonly type: "todo.update"; readonly text: string })
  | (TodoCommandBase & { readonly type: "todo.settle" })
  | (TodoCommandBase & { readonly type: "todo.unsettle" })
  | (TodoCommandBase & { readonly type: "todo.delete" });

/** The command targets a todo that does not exist or was removed. */
export class TodoCommandMissingTodoError extends Schema.TaggedError<TodoCommandMissingTodoError>()(
  "TodoCommandMissingTodoError",
  { commandType: Schema.String, todoId: TodoId },
) {
  override get message(): string {
    return `Todo '${this.todoId}' does not exist for command '${this.commandType}'.`;
  }
}

export class TodoCommandInvariantError extends Schema.TaggedError<TodoCommandInvariantError>()(
  "TodoCommandInvariantError",
  { commandType: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Todo command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export const TodoCommandRejection = Schema.Union([
  TodoCommandMissingTodoError,
  TodoCommandInvariantError,
]);
export type TodoCommandRejection = typeof TodoCommandRejection.Type;

const TodoCommandRejectionJson = Schema.fromJsonString(TodoCommandRejection);
/** Rejected receipts store the rejection so a retried command id replays the same error. */
export const encodeTodoCommandRejection = Schema.encodeSync(TodoCommandRejectionJson);
export const decodeTodoCommandRejection = Schema.decodeUnknownOption(TodoCommandRejectionJson);

/**
 * Decide one todo command against the todo's row (including a removed one).
 * Every accepted command produces exactly one event.
 *
 * Settle and unsettle follow thread settlement: repeating either re-emits the
 * current state (original `settledAt`, unchanged `updatedAt`), so double
 * clicks and agent retries are silent no-ops rather than errors.
 */
export function planTodoCommand(input: {
  readonly command: TodoCommand;
  readonly todo: TodoRow | undefined;
  readonly eventId: EventId;
  readonly now: DateTime.Utc;
}): Result.Result<UnsequencedTodoEvent, TodoCommandRejection> {
  const { command, todo } = input;
  const occurredAt = DateTime.formatIso(input.now);
  const base = {
    eventId: input.eventId,
    aggregateKind: "todo" as const,
    aggregateId: command.todoId,
    occurredAt,
    commandId: command.commandId,
    causationEventId: null,
    correlationId: command.commandId,
    metadata: {},
  };

  if (command.type === "todo.create") {
    if (todo !== undefined) {
      return Result.fail(
        new TodoCommandInvariantError({
          commandType: command.type,
          detail: `Todo '${command.todoId}' already exists and cannot be created twice.`,
        }),
      );
    }
    return Result.succeed({
      ...base,
      type: "todo.created",
      payload: {
        todoId: command.todoId,
        scopeKey: command.scopeKey,
        text: command.text,
        createdAt: occurredAt,
      },
    });
  }

  const active = todo?.deletedAt === null ? todo : undefined;
  if (active === undefined) {
    return Result.fail(
      new TodoCommandMissingTodoError({ commandType: command.type, todoId: command.todoId }),
    );
  }

  switch (command.type) {
    case "todo.update":
      return Result.succeed({
        ...base,
        type: "todo.updated",
        payload: {
          todoId: command.todoId,
          text: command.text,
          updatedAt: command.text === active.text ? active.updatedAt : occurredAt,
        },
      });
    case "todo.settle":
      return Result.succeed({
        ...base,
        type: "todo.settled",
        payload: {
          todoId: command.todoId,
          settledAt: active.settledAt ?? occurredAt,
          updatedAt: active.settledAt === null ? occurredAt : active.updatedAt,
        },
      });
    case "todo.unsettle":
      return Result.succeed({
        ...base,
        type: "todo.unsettled",
        payload: {
          todoId: command.todoId,
          updatedAt: active.settledAt === null ? active.updatedAt : occurredAt,
        },
      });
    case "todo.delete":
      return Result.succeed({
        ...base,
        type: "todo.deleted",
        payload: { todoId: command.todoId, deletedAt: occurredAt },
      });
  }
}
