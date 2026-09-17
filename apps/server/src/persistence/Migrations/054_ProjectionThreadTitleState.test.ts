import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

for (const upstreamColumnExists of [false, true]) {
  it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
    `054_ProjectionThreadTitleState ${upstreamColumnExists}`,
    (it) => {
      it.effect(
        `upgrades ${upstreamColumnExists ? "upstream" : "fork"} title state without losing rows`,
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runMigrations({ toMigrationInclusive: 53 });
            if (upstreamColumnExists) {
              yield* sql`ALTER TABLE projection_threads ADD COLUMN title_state_json TEXT`;
            }
            yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at, profile_snapshot_json)
            VALUES ('existing', 'project', 'Existing agent chat', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{"systemPrompt":"Keep these instructions"}')`;
            const before = yield* sql`SELECT title, profile_snapshot_json FROM projection_threads`;
            yield* runMigrations();
            const columns = yield* sql<{
              readonly name: string;
            }>`PRAGMA table_info(projection_threads)`;
            assert.equal(columns.filter((column) => column.name === "title_state_json").length, 1);
            assert.equal(
              columns.filter((column) => column.name === "profile_snapshot_json").length,
              1,
            );
            assert.deepEqual(
              yield* sql`SELECT title, profile_snapshot_json FROM projection_threads`,
              before,
            );
            assert.deepEqual(yield* runMigrations(), []);
          }),
      );
    },
  );
}
