import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const payload = (title: string) =>
  JSON.stringify({
    title,
    profileSnapshot: {
      name: "agent",
      systemPrompt: "prompt",
      skills: [{ body: "x".repeat(1000) }],
    },
  });

layer("fork/008_ProjectionThreadSlimPayloads", (it) => {
  it.effect("keeps a copy of each thread payload without profile skills", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      const insertThread = (threadId: string, title: string) => sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json, provider_instance_id)
        VALUES (${threadId}, 'project', ${title}, 'claude', 'full-access', 'default',
          '2026-10-23', '2026-10-23', ${payload(title)}, 'claude')
        ON CONFLICT (thread_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
      yield* insertThread("thread-existing", "existing");

      yield* runMigrations({ toForkMigrationInclusive: 8 });
      yield* insertThread("thread-new", "new");
      yield* insertThread("thread-existing", "renamed");
      yield* sql`
        UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'codex'
        WHERE thread_id = 'thread-new'
      `;
      yield* insertThread("thread-gone", "gone");
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-gone'`;

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly provider_instance_id: string;
        readonly payload_json: string;
      }>`
        SELECT thread_id, provider_instance_id, payload_json
        FROM orchestration_v2_projection_thread_slim_payloads ORDER BY thread_id
      `;
      assert.deepEqual(
        rows.map((row) => ({ ...row, payload_json: JSON.parse(row.payload_json) })),
        [
          {
            thread_id: "thread-existing",
            provider_instance_id: "claude",
            payload_json: {
              title: "renamed",
              profileSnapshot: { name: "agent", systemPrompt: "prompt" },
            },
          },
          {
            thread_id: "thread-new",
            provider_instance_id: "codex",
            payload_json: {
              title: "new",
              profileSnapshot: { name: "agent", systemPrompt: "prompt" },
            },
          },
        ],
      );
    }),
  );
});
