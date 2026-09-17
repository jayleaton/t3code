import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Upstream shipped this at 52, which the fork had already used.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "title_state_json")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
  }
});
