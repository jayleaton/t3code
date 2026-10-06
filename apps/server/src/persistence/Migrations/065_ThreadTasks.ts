import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One task per worker chat, and at most one settle-after-turn request per chat
// (see threadTask/ThreadTaskStore.ts). Payloads are the typed contracts; owner,
// cursor, and state are columns for the reads that filter on them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_tasks (
      worker_thread_id TEXT PRIMARY KEY,
      owner_thread_id TEXT NOT NULL,
      cursor INTEGER NOT NULL UNIQUE,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_tasks_owner
    ON thread_tasks(owner_thread_id, cursor)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_settle_requests (
      thread_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  // A task whose owner and worker are on different environments: this side's
  // capability and delivery cursor (see threadTask/ThreadTaskRemote.ts).
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_task_links (
      worker_thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      pending INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  // Timestamps of task transitions, wakes and deliveries, for measuring latency
  // and duplicates afterwards. Bounded by the store.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_task_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      worker_thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER,
      detail TEXT
    )
  `;
});
