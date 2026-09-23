import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";

describe("fork V2 preview migration boundary", () => {
  for (const previewId of [53, 54, 55]) {
    it.effect(`refuses preview ${previewId} without changing schema, history, or data`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: previewId - 1 });
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${previewId}, 'OrchestrationV2')`;
        yield* sql`CREATE TABLE preview_data (value TEXT)`;
        yield* sql`INSERT INTO preview_data VALUES ('preserve me')`;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, schema);
        assert.deepStrictEqual(yield* sql`SELECT * FROM preview_data`, [{ value: "preserve me" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  }
});
