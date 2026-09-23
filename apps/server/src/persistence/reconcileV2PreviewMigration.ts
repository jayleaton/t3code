import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Fork releases own migrations 1–55. Earlier V2 drafts used conflicting numbers.
// Refuse before any schema writes: recreate disposable preview state from a V1 snapshot.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (tables.length === 0) return;
  const previews =
    yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'OrchestrationV2' AND migration_id != 56`;
  if (previews.length > 0) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message:
        "This experimental V2 database uses an incompatible migration history. Recreate disposable preview state from a released fork V1 snapshot; do not use your live database.",
    });
  }
});
