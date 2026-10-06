import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One task per worker chat (see threadTask/ThreadTaskStore.ts). The payload is
// the typed ThreadTask; owner and cursor are columns for owner reads and watches.
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
});
