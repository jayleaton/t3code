import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../../Migrations.ts";

const row = (id: string, overrides: Record<string, unknown>) => ({
  task_id: id,
  title: id,
  prompt: "Run",
  enabled: 1,
  schedule_json: '{"type":"interval","everyMs":60000}',
  project_id: "project-1",
  thread_id: null,
  profile_id: null,
  workspace_strategy_json: '{"type":"root"}',
  model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
  runtime_mode: "full-access",
  interaction_mode: "default",
  created_by: "user",
  creation_source: "web",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  next_run_at: null,
  last_run_at: null,
  last_run_status: "never",
  last_run_error: null,
  run_count: 0,
  ...overrides,
});

it.effect("adds the cleanup columns, continues profile tasks and keeps webhook tokens", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toForkMigrationInclusive: 22 });
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert(
      row("agent", { profile_id: "reviewer", thread_id: "thread-1", thread_mode: "new_thread" }),
    )}`;
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert(
      row("fresh", { thread_mode: "new_thread" }),
    )}`;
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert(
      row("hook", {
        schedule_json: '{"type":"webhook","signature":null}',
        webhook_token: "token-unchanged",
      }),
    )}`;
    yield* runMigrations();

    const columns = (yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`).map(
      (column) => column.name,
    );
    for (const name of ["archived_at", "archive_reason", "failing_since", "consecutive_failures"]) {
      assert.include(columns, name);
    }
    const rows = yield* sql<{
      task_id: string;
      thread_mode: string;
      webhook_token: string | null;
      archived_at: string | null;
      consecutive_failures: number;
    }>`SELECT task_id, thread_mode, webhook_token, archived_at, consecutive_failures
       FROM scheduled_tasks ORDER BY task_id`;
    assert.deepEqual(
      rows.map((entry) => [entry.task_id, entry.thread_mode, entry.webhook_token]),
      [
        ["agent", "continue", null],
        ["fresh", "new_thread", null],
        ["hook", "new_thread", "token-unchanged"],
      ],
    );
    assert.isTrue(rows.every((entry) => entry.archived_at === null));
    assert.isTrue(rows.every((entry) => entry.consecutive_failures === 0));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
