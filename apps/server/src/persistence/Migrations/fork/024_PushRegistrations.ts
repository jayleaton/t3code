import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Phones this server pushes to directly through Expo. A row only receives
// pushes while its session is live, so revoking the device stops them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE push_registrations (
      install_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      expo_push_token TEXT NOT NULL UNIQUE,
      label TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
