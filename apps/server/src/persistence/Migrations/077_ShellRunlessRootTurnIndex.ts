import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Shells look up each thread's latest run-less root turn. Without this index
// that reads every run-less node row of every thread on each snapshot.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_nodes_runless_root_turn_idx
    ON orchestration_v2_projection_nodes(thread_id, COALESCE(started_at, ''), node_id)
    WHERE run_id IS NULL AND kind = 'root_turn'
  `;
});
