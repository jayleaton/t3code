// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import {
  applyReviewedCandidates,
  selectRecoveryCandidates,
  type RecoveryCandidate,
} from "./recover-completion-settlements.ts";

const NOW = Date.parse("2026-10-04T00:00:00.000Z");
const completedAt = "2026-10-03T10:00:00.000Z";
const settledAt = "2026-10-03T10:00:30.000Z";

function withMigratedDatabase<A>(run: (db: NodeSqlite.DatabaseSync) => A) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-settlement-recovery-"));
  const dbPath = NodePath.join(tempDir, "statev2.sqlite");
  const threadVersions = new Map<string, number>();

  const appendEvent = (
    sql: SqlClient.SqlClient,
    threadId: string,
    type: string,
    payload: object,
    commandId: string | null = null,
  ) => {
    const streamVersion = threadVersions.get(threadId) ?? 0;
    threadVersions.set(threadId, streamVersion + 1);
    return sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`event:${threadId}:${streamVersion}`}, 'thread', ${threadId}, ${streamVersion},
        ${type}, ${settledAt}, ${commandId}, 'server', ${JSON.stringify(payload)}, '{}', 2
      )
    `;
  };

  const insertThread = (sql: SqlClient.SqlClient, threadId: string, title: string, state: object) =>
    sql`INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at, payload_json
    ) VALUES (
      ${threadId}, 'project:test', ${title}, 'codex', 'full-access', 'default',
      ${completedAt}, ${settledAt}, NULL, ${JSON.stringify(state)}
    )`;

  const insertRun = (sql: SqlClient.SqlClient, threadId: string, runId: string) =>
    sql`INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
    ) VALUES (${runId}, ${threadId}, 1, 'codex', 'completed', ${completedAt}, ${completedAt}, '{}')`;

  const insertSettleReceipt = (
    sql: SqlClient.SqlClient,
    threadId: string,
    runId: string,
    commandId: string,
  ) =>
    sql`INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, command_type, accepted_at,
      result_sequence, status, error
    ) VALUES (${commandId}, 'thread', ${threadId}, 'thread.sub-run.settle', ${settledAt}, 0, 'accepted', NULL)`;

  const writeFixtures = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const automatic = (threadId: string, runId: string, parentThreadId?: string) =>
      Effect.gen(function* () {
        const commandId = `server:sub-run-settle:${threadId}:${runId}`;
        yield* insertThread(sql, threadId, threadId, {
          settledOverride: "settled",
          settledAt,
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
        });
        yield* insertRun(sql, threadId, runId);
        yield* insertSettleReceipt(sql, threadId, runId, commandId);
        if (parentThreadId !== undefined)
          yield* appendEvent(sql, threadId, "thread.created", { parentThreadId });
        yield* appendEvent(sql, threadId, "thread.settled", { settledAt }, commandId);
      });

    yield* automatic("child-auto", "run-a");

    yield* insertThread(sql, "manual", "manual", { settledOverride: "settled", settledAt });
    yield* insertRun(sql, "manual", "run-m");
    yield* sql`INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, command_type, accepted_at,
      result_sequence, status, error
    ) VALUES ('user:manual', 'thread', 'manual', 'thread.settle', ${settledAt}, 0, 'accepted', NULL)`;
    yield* appendEvent(sql, "manual", "thread.settled", { settledAt }, "user:manual");

    yield* insertThread(sql, "parent", "parent", { settledOverride: "settled", settledAt });
    yield* appendEvent(sql, "parent", "thread.settled", { settledAt }, "user:parent");
    yield* automatic("child-cascade", "run-c", "parent");

    yield* automatic("child-later-state", "run-l");
    yield* appendEvent(sql, "child-later-state", "thread.unsettled", { settledAt: null }, "later");
  });

  return Effect.gen(function* () {
    yield* writeFixtures.pipe(
      Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    );
    const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return run(db);
    } finally {
      db.close();
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

describe("selectRecoveryCandidates", () => {
  it.effect(
    "uses migrated app-event and receipt tables, excluding manual commands, parent cascades, and superseded state",
    () =>
      withMigratedDatabase((db) => {
        const candidates = selectRecoveryCandidates(db, { nowMs: NOW });
        expect(candidates).toEqual([
          {
            threadId: "child-auto",
            title: "child-auto",
            runId: "run-a",
            completedAt,
            settledAt,
          },
        ]);
      }),
  );

  it.effect("requires a close completion timestamp and current projection match", () =>
    withMigratedDatabase((db) => {
      expect(selectRecoveryCandidates(db, { nowMs: NOW, sinceDays: 2, withinMs: 10 })).toEqual([]);
    }),
  );
});

describe("applyReviewedCandidates", () => {
  const candidate: RecoveryCandidate = {
    threadId: "approved",
    title: "Approved",
    runId: "run-1",
    completedAt,
    settledAt,
  };

  it("unsettles only explicitly reviewed IDs through MCP after confirming the live settledAt", async () => {
    const callTool = vi.fn(async (tool: string) =>
      tool === "t3_thread_read"
        ? { structuredContent: { thread: { settled: true, settledAt } } }
        : { structuredContent: { sequence: 4 } },
    );
    const result = await applyReviewedCandidates({
      candidates: [candidate],
      reviewedThreadIds: ["approved"],
      callTool,
    });
    expect(result).toEqual([
      { threadId: "approved", result: { structuredContent: { sequence: 4 } } },
    ]);
    expect(callTool.mock.calls).toEqual([
      ["t3_thread_read", { threadId: "approved" }],
      ["t3_thread_organize", { threadId: "approved", action: "unsettle" }],
    ]);
  });

  it("skips a thread whose live settlement changed after review", async () => {
    const callTool = vi.fn(async () => ({ thread: { settled: true, settledAt: "different" } }));
    const result = await applyReviewedCandidates({
      candidates: [candidate],
      reviewedThreadIds: ["approved"],
      callTool,
    });
    expect(result).toEqual([]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects IDs that were not in the dry-run manifest", async () => {
    await expect(
      applyReviewedCandidates({
        candidates: [candidate],
        reviewedThreadIds: ["unreviewed"],
        callTool: vi.fn(),
      }),
    ).rejects.toThrow("not current recovery candidates");
  });
});
