import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MessageId, ThreadId } from "@t3tools/contracts";

import { runMigrations } from "../Migrations.ts";
import { ProjectionThreadMessageRepositoryLive } from "../Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("agents migration 52 upgrade", (it) => {
  it.effect("repairs message reads when a shipped build already recorded migration 52", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
        (51, 'AgentProfileAndPullRequestCompatibility', CURRENT_TIMESTAMP),
        (52, 'ProjectionThreadListState', CURRENT_TIMESTAMP)`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('existing-message', 'existing-thread', 'user', 'Keep this message', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

      yield* runMigrations();
      const messages = yield* sql<{ text: string; context: string | null }>`
        SELECT text, context_json AS context FROM projection_thread_messages
        WHERE thread_id = 'existing-thread'
      `;
      assert.deepEqual(messages, [{ text: "Keep this message", context: null }]);
      yield* Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        const threadId = ThreadId.make("existing-thread");
        const now = "2026-09-16T00:00:00Z";
        yield* repository.upsert({
          messageId: MessageId.make("new-message"),
          threadId,
          turnId: null,
          role: "user",
          text: "New message after upgrade",
          isStreaming: false,
          createdAt: now,
          updatedAt: now,
        });
        const saved = yield* repository.listByThreadId({ threadId });
        assert.sameMembers(
          saved.map((message) => message.text),
          ["Keep this message", "New message after upgrade"],
        );
      }).pipe(Effect.provide(ProjectionThreadMessageRepositoryLive));
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});

layer("050_ProjectionThreadProfileSnapshot", (it) => {
  it.effect("adds the nullable profile snapshot to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 52 });

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
      yield* runMigrations({ toMigrationInclusive: 52 });
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.isTrue(columns.some((column) => column.name === "profile_snapshot_json"));
      assert.isTrue(columns.some((column) => column.name === "branch_pull_request_json"));
    }),
  );
});

layer("agents migration 49 upgrade", (it) => {
  it.effect(
    "preserves frozen instructions and repairs active ordering from an early agents build",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 48 });
        yield* sql`ALTER TABLE projection_threads ADD COLUMN profile_snapshot_json TEXT`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (49, 'ProjectionThreadProfileSnapshot', CURRENT_TIMESTAMP)`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at, profile_snapshot_json)
        VALUES ('existing', 'project', 'Existing agent chat', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{"systemPrompt":"Keep these instructions"}')`;
        yield* runMigrations();
        const rows = yield* sql<{
          readonly snapshot: string;
          readonly activeOrder: string | null;
        }>`SELECT profile_snapshot_json AS snapshot, active_order_key AS activeOrder FROM projection_threads WHERE thread_id = 'existing'`;
        assert.deepEqual(rows, [
          { snapshot: '{"systemPrompt":"Keep these instructions"}', activeOrder: null },
        ]);
      }),
  );
});

layer("agents migration 50 upgrade", (it) => {
  it.effect("repairs PR storage when migration 50 was already used for agent profiles", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN profile_snapshot_json TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (50, 'ProjectionThreadProfileSnapshot', CURRENT_TIMESTAMP)`;
      yield* runMigrations();
      const tables = yield* sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_thread_pull_requests'`;
      assert.equal(tables.length, 1);
    }),
  );
});

layer("agents migration 51 upgrade", (it) => {
  it.effect("adds upstream context when a shipped agent build already used migration 51", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN profile_snapshot_json TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (51, 'AgentProfileAndPullRequestCompatibility', CURRENT_TIMESTAMP)`;
      yield* runMigrations();
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.isTrue(columns.some((column) => column.name === "context_json"));
    }),
  );
});
