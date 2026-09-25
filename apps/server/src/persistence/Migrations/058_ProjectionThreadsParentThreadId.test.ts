import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateParentThreadId from "./058_ProjectionThreadsParentThreadId.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "058_ProjectionThreadsParentThreadId",
  (it) => {
    it.effect("adds an empty parent link to existing threads and is safe to re-run", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 57 });
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            created_at, updated_at
          ) VALUES (
            'thread-1', 'project-1', 'Existing thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
          )
        `;
        yield* runMigrations({ toMigrationInclusive: 58 });
        const migrated = yield* sql<{ readonly parentThreadId: string | null }>`
          SELECT parent_thread_id AS "parentThreadId" FROM projection_threads
        `;
        assert.deepEqual(migrated, [{ parentThreadId: null }]);
        yield* sql`UPDATE projection_threads SET parent_thread_id = 'parent-1'`;
        yield* migrateParentThreadId;
        const rows = yield* sql<{ readonly parentThreadId: string | null }>`
          SELECT parent_thread_id AS "parentThreadId" FROM projection_threads
        `;
        assert.deepEqual(rows, [{ parentThreadId: "parent-1" }]);
      }),
    );
  },
);
