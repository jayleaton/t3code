import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Plain state rather than an event stream: a task is configuration plus the outcome of its last
  // run, and its history already lives in the thread every run posts to.
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run_at TEXT,
      last_run_at TEXT,
      last_run_status TEXT,
      last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
    ON scheduled_tasks (next_run_at)
    WHERE enabled = 1 AND next_run_at IS NOT NULL
  `;
});
