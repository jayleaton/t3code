import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Replicated across the user's tailnet devices; rows merge last-writer-wins by stamp.
  yield* sql`
    CREATE TABLE tailnet_device_policy (
      environment_id TEXT PRIMARY KEY,
      access TEXT NOT NULL,
      stamp_json TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )
  `;
});
