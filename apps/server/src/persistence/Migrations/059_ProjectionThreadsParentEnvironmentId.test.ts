import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateParentEnvironmentId from "./059_ProjectionThreadsParentEnvironmentId.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "059_ProjectionThreadsParentEnvironmentId",
  (it) => {
    it.effect("keeps existing parent links local and is safe to re-run", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 58 });
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            created_at, updated_at, parent_thread_id
          ) VALUES (
            'thread-1', 'project-1', 'Existing thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}, 'parent-1'
          )
        `;
        yield* runMigrations({ toMigrationInclusive: 59 });
        const migrated = yield* sql<{ readonly parentEnvironmentId: string | null }>`
          SELECT parent_environment_id AS "parentEnvironmentId" FROM projection_threads
        `;
        assert.deepEqual(migrated, [{ parentEnvironmentId: null }]);
        yield* sql`UPDATE projection_threads SET parent_environment_id = 'environment-2'`;
        yield* migrateParentEnvironmentId;
        const rows = yield* sql<{ readonly parentEnvironmentId: string | null }>`
          SELECT parent_environment_id AS "parentEnvironmentId" FROM projection_threads
        `;
        assert.deepEqual(rows, [{ parentEnvironmentId: "environment-2" }]);
      }),
    );
  },
);
