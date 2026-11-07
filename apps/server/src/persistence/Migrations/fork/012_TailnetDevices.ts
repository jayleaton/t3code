import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The environment that holds the session, when it is another T3 server.
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN peer_environment_id TEXT`;
  yield* sql`
    CREATE INDEX auth_sessions_peer_environment_idx
    ON auth_sessions(peer_environment_id) WHERE peer_environment_id IS NOT NULL
  `;

  yield* sql`
    ALTER TABLE peer_environment_links ADD COLUMN origin TEXT NOT NULL DEFAULT 'paired'
  `;

  // Servers found on the tailnet or named by a linked device, linked or not yet.
  yield* sql`
    CREATE TABLE tailnet_devices (
      environment_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      tailnet_name TEXT,
      last_seen_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE tailnet_device_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL
    )
  `;
});
