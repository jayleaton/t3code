import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Settling a card walks its sub-runs one parent at a time. Without this index
// each lookup parses every thread payload, profile skills included, so a card
// with a hundred sub-runs took minutes to settle them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_parent_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.parentThreadId'))
  `;
});
