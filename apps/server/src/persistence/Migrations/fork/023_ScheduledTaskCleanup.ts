import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Columns the stale-task sweep reads and writes, plus the mode legacy profile imports missed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN archived_at TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN archive_reason TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN failing_since TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0`;
  // An agent task always reuses the thread its first run launched.
  yield* sql`UPDATE scheduled_tasks SET thread_mode = 'continue' WHERE profile_id IS NOT NULL AND thread_mode = 'new_thread'`;
});
