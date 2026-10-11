import { EnvironmentId, ThreadId, ThreadSettleRequest, ThreadTask } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** One side of a cross-environment task. The capability never leaves the servers. */
export const ThreadTaskLink = Schema.Struct({
  workerThreadId: ThreadId,
  /** This environment's side: the worker's authoritative record, or the owner's mirror. */
  role: Schema.Literals(["worker", "owner"]),
  peerEnvironmentId: EnvironmentId,
  capability: Schema.String,
  /** Worker side: last cursor the owner acknowledged. Owner side: last worker cursor applied. */
  deliveredCursor: Schema.Number,
  /** Worker side: the cursor delivery is trying to reach. */
  pendingCursor: Schema.Number,
  state: Schema.Literals(["synced", "pending", "unreachable"]),
  lastSyncedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  /** Owner side: the worker's run state and continuation as last delivered. */
  remoteWorkerRun: Schema.optional(Schema.Literals(["running", "waiting_input", "idle"])),
  remoteContinuationLive: Schema.optional(Schema.Boolean),
  /** Owner side: the assignment this link carries, so a retried assignment reuses it. */
  taskId: Schema.optional(Schema.String),
  assignRequestId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ThreadTaskLink = typeof ThreadTaskLink.Type;
const decodeLink = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadTaskLink));
const encodeLink = Schema.encodeEffect(Schema.fromJsonString(ThreadTaskLink));

export type ThreadTaskEventKind =
  | "transition"
  | "wake_queued"
  | "wake_delivered"
  | "wake_skipped"
  /** A turn end the owner already holds the answer to; detail names the run and revision. */
  | "wake_suppressed"
  | "remote_sync_ok"
  | "remote_sync_failed"
  | "remote_applied"
  | "remote_duplicate"
  | "owner_action"
  | "message_denied";

const EVENT_RETENTION = 20_000;

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
const decodeSettleRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadSettleRequest));
const encodeSettleRequest = Schema.encodeEffect(Schema.fromJsonString(ThreadSettleRequest));

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
    /** Tasks with this project key, newest change first, at most `limit`. */
    readonly listByProjectKey: (input: {
      readonly projectKey: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<ThreadTask>, ThreadTaskStoreError>;
    readonly listByOwner: (
      ownerThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadTask>, ThreadTaskStoreError>;
    /** Tasks with an undelivered wake or an unfinished settlement, for restart recovery. */
    readonly listUnfinished: () => Effect.Effect<ReadonlyArray<ThreadTask>, ThreadTaskStoreError>;
    readonly latestCursor: Effect.Effect<number, ThreadTaskStoreError>;
    readonly getLink: (
      workerThreadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadTaskLink>, ThreadTaskStoreError>;
    readonly putLink: (link: ThreadTaskLink) => Effect.Effect<void, ThreadTaskStoreError>;
    /** Worker-side links whose owner has not acknowledged the latest change. */
    readonly listPendingLinks: () => Effect.Effect<
      ReadonlyArray<ThreadTaskLink>,
      ThreadTaskStoreError
    >;
    readonly listLinks: () => Effect.Effect<ReadonlyArray<ThreadTaskLink>, ThreadTaskStoreError>;
    readonly appendEvent: (event: {
      readonly at: string;
      readonly workerThreadId: ThreadId;
      readonly kind: ThreadTaskEventKind;
      readonly revision?: number | undefined;
      readonly detail?: string | undefined;
    }) => Effect.Effect<void, ThreadTaskStoreError>;
    readonly getSettleRequest: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadSettleRequest>, ThreadTaskStoreError>;
    readonly listPendingSettleRequests: () => Effect.Effect<
      ReadonlyArray<ThreadSettleRequest>,
      ThreadTaskStoreError
    >;
    readonly putSettleRequest: (
      request: ThreadSettleRequest,
    ) => Effect.Effect<void, ThreadTaskStoreError>;
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

  const decodeSettleRows =
    (operation: string) => (rows: ReadonlyArray<{ readonly payload: string }>) =>
      Effect.forEach(rows, (row) => decodeSettleRequest(row.payload)).pipe(
        Effect.mapError(fail(operation)),
      );

  const decodeLinkRows =
    (operation: string) => (rows: ReadonlyArray<{ readonly payload: string }>) =>
      Effect.forEach(rows, (row) => decodeLink(row.payload)).pipe(Effect.mapError(fail(operation)));
  let eventsSincePrune = 0;

  return ThreadTaskStore.of({
    getLink: (workerThreadId) =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_task_links WHERE worker_thread_id = ${workerThreadId}
      `.pipe(
        Effect.mapError(fail("get-link")),
        Effect.flatMap(decodeLinkRows("get-link")),
        Effect.map((links) => Option.fromNullishOr(links[0])),
      ),
    putLink: (link) =>
      Effect.gen(function* () {
        const payload = yield* encodeLink(link).pipe(Effect.mapError(fail("encode-link")));
        const pending = link.role === "worker" && link.pendingCursor > link.deliveredCursor ? 1 : 0;
        yield* sql`
          INSERT INTO thread_task_links (worker_thread_id, role, pending, payload_json)
          VALUES (${link.workerThreadId}, ${link.role}, ${pending}, ${payload})
          ON CONFLICT (worker_thread_id) DO UPDATE SET
            role = excluded.role,
            pending = excluded.pending,
            payload_json = excluded.payload_json
        `.pipe(Effect.mapError(fail("put-link")));
      }),
    listPendingLinks: () =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_task_links WHERE role = 'worker' AND pending = 1
      `.pipe(
        Effect.mapError(fail("list-pending-links")),
        Effect.flatMap(decodeLinkRows("list-pending-links")),
      ),
    listLinks: () =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_task_links
      `.pipe(Effect.mapError(fail("list-links")), Effect.flatMap(decodeLinkRows("list-links"))),
    appendEvent: (event) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO thread_task_events (at, worker_thread_id, kind, revision, detail)
          VALUES (${event.at}, ${event.workerThreadId}, ${event.kind}, ${event.revision ?? null}, ${event.detail ?? null})
        `.pipe(Effect.mapError(fail("append-event")));
        eventsSincePrune += 1;
        if (eventsSincePrune >= 500) {
          eventsSincePrune = 0;
          yield* sql`
            DELETE FROM thread_task_events
            WHERE sequence <= (SELECT MAX(sequence) FROM thread_task_events) - ${EVENT_RETENTION}
          `.pipe(Effect.mapError(fail("prune-events")));
        }
      }),
    getSettleRequest: (threadId) =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_settle_requests WHERE thread_id = ${threadId}
      `.pipe(
        Effect.mapError(fail("get-settle-request")),
        Effect.flatMap(decodeSettleRows("get-settle-request")),
        Effect.map((requests) => Option.fromNullishOr(requests[0])),
      ),
    listPendingSettleRequests: () =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_settle_requests WHERE state = 'pending'
      `.pipe(
        Effect.mapError(fail("list-settle-requests")),
        Effect.flatMap(decodeSettleRows("list-settle-requests")),
      ),
    putSettleRequest: (request) =>
      Effect.gen(function* () {
        const payload = yield* encodeSettleRequest(request).pipe(Effect.mapError(fail("encode")));
        yield* sql`
          INSERT INTO thread_settle_requests (thread_id, state, payload_json)
          VALUES (${request.threadId}, ${request.state}, ${payload})
          ON CONFLICT (thread_id) DO UPDATE SET
            state = excluded.state,
            payload_json = excluded.payload_json
        `.pipe(Effect.mapError(fail("put-settle-request")));
      }),
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
    listByProjectKey: ({ projectKey, limit }) =>
      sql<{ readonly payload: string }>`
        SELECT payload_json AS payload FROM thread_tasks
        WHERE json_extract(payload_json, '$.projectKey') = ${projectKey}
        ORDER BY cursor DESC
        LIMIT ${limit}
      `.pipe(
        Effect.mapError(fail("list-by-project-key")),
        Effect.flatMap(decodeRows("list-by-project-key")),
      ),
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
