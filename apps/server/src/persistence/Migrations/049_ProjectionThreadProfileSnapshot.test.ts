import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ProjectionThreadProfileSnapshot", (it) => {
  it.effect("adds the nullable profile snapshot to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 49 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const profileSnapshot = columns.find((column) => column.name === "profile_snapshot_json");

      assert.equal(profileSnapshot?.name, "profile_snapshot_json");
      assert.equal(profileSnapshot?.notnull, 0);
    }),
  );
});

layer("gateway migration upgrade", (it) => {
  it.effect("upgrades a database where the gateway already used migration 48", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN profile_snapshot_json TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (48, 'ProjectionThreadProfileSnapshot', CURRENT_TIMESTAMP)`;
      yield* runMigrations({ toMigrationInclusive: 49 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "profile_snapshot_json"));
      assert.isTrue(columns.some((column) => column.name === "branch_pull_request_json"));
    }),
  );
});
