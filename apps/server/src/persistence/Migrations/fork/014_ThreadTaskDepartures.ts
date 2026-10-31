import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A task that moved to another owner, under the cursor of that move, so the
// former owner's delta reads drop it (see threadTask/ThreadTaskStore.ts).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_task_departures (
      worker_thread_id TEXT NOT NULL,
      owner_thread_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      PRIMARY KEY (worker_thread_id, owner_thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_task_departures_owner
    ON thread_task_departures(owner_thread_id, cursor)
  `;
});
