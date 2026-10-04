import { IsoDateTime, TodoId, type TodoEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export class TodoStoreError extends Schema.TaggedError<TodoStoreError>()("TodoStoreError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Todo store operation '${this.operation}' failed.`;
  }
}

/** One row of `projection_todos`, the durable todo read model. */
export const TodoRow = Schema.Struct({
  todoId: TodoId,
  scopeKey: Schema.String,
  text: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  settledAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type TodoRow = typeof TodoRow.Type;

export class TodoStore extends Context.Service<
  TodoStore,
  {
    /** Fold one committed todo event into its row. Call inside the commit transaction. */
    readonly apply: (event: TodoEvent) => Effect.Effect<void, TodoStoreError>;
    /** A todo's row, including a removed one. */
    readonly get: (todoId: TodoId) => Effect.Effect<Option.Option<TodoRow>, TodoStoreError>;
    /** Active todos oldest first, then the newest `settledLimit` settled ones. */
    readonly listByScope: (input: {
      readonly scopeKey: string;
      readonly settledLimit: number;
    }) => Effect.Effect<
      {
        readonly active: ReadonlyArray<TodoRow>;
        readonly settled: ReadonlyArray<TodoRow>;
        readonly settledCount: number;
      },
      TodoStoreError
    >;
  }
>()("t3/todo/TodoStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectById = SqlSchema.findAll({
    Request: Schema.Struct({ todoId: TodoId }),
    Result: TodoRow,
    execute: ({ todoId }) => sql`
      SELECT
        todo_id AS "todoId",
        scope_key AS "scopeKey",
        text,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        settled_at AS "settledAt",
        deleted_at AS "deletedAt"
      FROM projection_todos
      WHERE todo_id = ${todoId}
    `,
  });

  const selectActive = SqlSchema.findAll({
    Request: Schema.Struct({ scopeKey: Schema.String }),
    Result: TodoRow,
    execute: ({ scopeKey }) => sql`
      SELECT
        todo_id AS "todoId",
        scope_key AS "scopeKey",
        text,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        settled_at AS "settledAt",
        deleted_at AS "deletedAt"
      FROM projection_todos
      WHERE scope_key = ${scopeKey} AND deleted_at IS NULL AND settled_at IS NULL
      ORDER BY created_at ASC, todo_id ASC
    `,
  });

  const selectSettled = SqlSchema.findAll({
    Request: Schema.Struct({ scopeKey: Schema.String, limit: Schema.Number }),
    Result: TodoRow,
    execute: ({ scopeKey, limit }) => sql`
      SELECT
        todo_id AS "todoId",
        scope_key AS "scopeKey",
        text,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        settled_at AS "settledAt",
        deleted_at AS "deletedAt"
      FROM projection_todos
      WHERE scope_key = ${scopeKey} AND deleted_at IS NULL AND settled_at IS NOT NULL
      ORDER BY settled_at DESC, todo_id DESC
      LIMIT ${limit}
    `,
  });

  const countSettled = (scopeKey: string) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_todos
      WHERE scope_key = ${scopeKey} AND deleted_at IS NULL AND settled_at IS NOT NULL
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  const upsert = (row: TodoRow) => sql`
    INSERT INTO projection_todos (
      todo_id, scope_key, text, created_at, updated_at, settled_at, deleted_at
    )
    VALUES (
      ${row.todoId}, ${row.scopeKey}, ${row.text}, ${row.createdAt},
      ${row.updatedAt}, ${row.settledAt}, ${row.deletedAt}
    )
    ON CONFLICT (todo_id) DO UPDATE SET
      scope_key = excluded.scope_key,
      text = excluded.text,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      settled_at = excluded.settled_at,
      deleted_at = excluded.deleted_at
  `;

  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TodoStoreError({ operation, cause })));

  const get: TodoStore["Service"]["get"] = (todoId) =>
    selectById({ todoId }).pipe(
      Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
      mapError("get"),
    );

  const apply: TodoStore["Service"]["apply"] = Effect.fn("TodoStore.apply")(function* (event) {
    if (event.type === "todo.created") {
      const payload = event.payload;
      return yield* upsert({
        todoId: payload.todoId,
        scopeKey: payload.scopeKey,
        text: payload.text,
        createdAt: payload.createdAt,
        updatedAt: payload.createdAt,
        settledAt: null,
        deletedAt: null,
      }).pipe(mapError("apply"));
    }
    const existing = yield* get(event.payload.todoId);
    if (Option.isNone(existing)) return;
    const row = existing.value;
    const next: TodoRow = (() => {
      switch (event.type) {
        case "todo.updated":
          return { ...row, text: event.payload.text, updatedAt: event.payload.updatedAt };
        case "todo.settled":
          return {
            ...row,
            settledAt: event.payload.settledAt,
            updatedAt: event.payload.updatedAt,
          };
        case "todo.unsettled":
          return { ...row, settledAt: null, updatedAt: event.payload.updatedAt };
        case "todo.deleted":
          return { ...row, deletedAt: event.payload.deletedAt, updatedAt: event.payload.deletedAt };
      }
    })();
    yield* upsert(next).pipe(mapError("apply"));
  });

  const listByScope: TodoStore["Service"]["listByScope"] = ({ scopeKey, settledLimit }) =>
    Effect.all([
      selectActive({ scopeKey }),
      selectSettled({ scopeKey, limit: settledLimit }),
      countSettled(scopeKey),
    ]).pipe(
      Effect.map(([active, settled, settledCount]) => ({ active, settled, settledCount })),
      mapError("listByScope"),
    );

  return TodoStore.of({ apply, get, listByScope });
});

export const layer = Layer.effect(TodoStore, make);
