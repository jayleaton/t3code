import { ThreadTask, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ThreadTaskStoreError extends Schema.TaggedError<ThreadTaskStoreError>()(
  "ThreadTaskStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread task store operation '${this.operation}' failed.`;
  }
}

const decodeTask = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTask));
const encodeTask = Schema.encodeEffect(Schema.fromJsonString(ThreadTask));

/** `thread_tasks`: one typed task per worker chat. Writers serialize through ThreadTaskService. */
export class ThreadTaskStore extends Context.Service<
  ThreadTaskStore,
  {
    readonly get: (
      workerThreadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadTask>, ThreadTaskStoreError>;
    /** Tasks the thread owns or works on, oldest change first, after `afterCursor`. */
    readonly listVisible: (input: {
      readonly threadId: ThreadId | null;
      readonly afterCursor: number;
    }) => Effect.Effect<ReadonlyArray<ThreadTask>, ThreadTaskStoreError>;
    readonly listByOwner: (
      ownerThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadTask>, ThreadTaskStoreError>;
    /** Tasks with an undelivered wake or an unfinished settlement, for restart recovery. */
    readonly listUnfinished: () => Effect.Effect<ReadonlyArray<ThreadTask>, ThreadTaskStoreError>;
    readonly latestCursor: Effect.Effect<number, ThreadTaskStoreError>;
    /** Writes the task under the next cursor and returns it as stored. */
    readonly put: (task: ThreadTask) => Effect.Effect<ThreadTask, ThreadTaskStoreError>;
  }
>()("t3/threadTask/ThreadTaskStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fail = (operation: string) => (cause: unknown) =>
    new ThreadTaskStoreError({ operation, cause });
  const decodeRows = (operation: string) => (rows: ReadonlyArray<{ readonly payload: string }>) =>
    Effect.forEach(rows, (row) => decodeTask(row.payload)).pipe(Effect.mapError(fail(operation)));

  const latestCursor = sql<{ readonly cursor: number }>`
    SELECT COALESCE(MAX(cursor), 0) AS cursor FROM thread_tasks
  `.pipe(
    Effect.map((rows) => Number(rows[0]?.cursor ?? 0)),
    Effect.mapError(fail("latest-cursor")),
  );

  return ThreadTaskStore.of({
    get: (workerThreadId) =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_tasks WHERE worker_thread_id = ${workerThreadId}
      `.pipe(
        Effect.mapError(fail("get")),
        Effect.flatMap(decodeRows("get")),
        Effect.map((tasks) => Option.fromNullishOr(tasks[0])),
      ),
    listVisible: ({ threadId, afterCursor }) =>
      (threadId === null
        ? sql<{ readonly payload: string }>`
            SELECT payload_json AS payload FROM thread_tasks
            WHERE cursor > ${afterCursor} ORDER BY cursor
          `
        : sql<{ readonly payload: string }>`
            SELECT payload_json AS payload FROM thread_tasks
            WHERE cursor > ${afterCursor}
              AND (owner_thread_id = ${threadId} OR worker_thread_id = ${threadId})
            ORDER BY cursor
          `
      ).pipe(Effect.mapError(fail("list-visible")), Effect.flatMap(decodeRows("list-visible"))),
    listByOwner: (ownerThreadId) =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_tasks
        WHERE owner_thread_id = ${ownerThreadId} ORDER BY cursor
      `.pipe(Effect.mapError(fail("list-by-owner")), Effect.flatMap(decodeRows("list-by-owner"))),
    listUnfinished: () =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_tasks
        WHERE json_extract(payload_json, '$.wake.state') = 'pending'
           OR json_extract(payload_json, '$.settlement.state') = 'pending'
        ORDER BY cursor
      `.pipe(
        Effect.mapError(fail("list-unfinished")),
        Effect.flatMap(decodeRows("list-unfinished")),
      ),
    latestCursor,
    put: (task) =>
      Effect.gen(function* () {
        const cursor = (yield* latestCursor) + 1;
        const stored = { ...task, cursor };
        const payload = yield* encodeTask(stored).pipe(Effect.mapError(fail("encode")));
        yield* sql`
          INSERT INTO thread_tasks (worker_thread_id, owner_thread_id, cursor, payload_json)
          VALUES (${stored.workerThreadId}, ${stored.ownerThreadId}, ${cursor}, ${payload})
          ON CONFLICT (worker_thread_id) DO UPDATE SET
            owner_thread_id = excluded.owner_thread_id,
            cursor = excluded.cursor,
            payload_json = excluded.payload_json
        `.pipe(Effect.mapError(fail("put")));
        return stored;
      }),
  });
});

export const layer = Layer.effect(ThreadTaskStore, make);
