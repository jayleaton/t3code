// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - This one-shot host utility reads SQLite in read-only mode and reports its manifest to the invoking terminal.
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { callAcpMcpTool } from "../src/mcp/AcpMcpStdioBridge.ts";

export interface RecoveryCandidate {
  readonly threadId: string;
  readonly title: string;
  readonly runId: string;
  readonly completedAt: string;
  readonly settledAt: string;
}

interface Db {
  prepare(sql: string): {
    all(...args: unknown[]): Record<string, unknown>[];
    get(...args: unknown[]): Record<string, unknown> | undefined;
  };
}

const LIFECYCLE_EVENTS = "'thread.settled', 'thread.unsettled'";

/**
 * Find only settlements made by the old run-completion reactor. Parent cascade
 * settlements carry the parent's settledAt, so compare the parent's state at
 * the child event's sequence and exclude matching manual cascades.
 */
export function selectRecoveryCandidates(
  db: Db,
  options: { readonly nowMs: number; readonly sinceDays?: number; readonly withinMs?: number },
): RecoveryCandidate[] {
  const since = DateTime.formatIso(
    DateTime.makeUnsafe(options.nowMs - (options.sinceDays ?? 7) * 86_400_000),
  );
  const withinMs = options.withinMs ?? 60_000;
  const rows = db
    .prepare(`
    SELECT t.thread_id AS threadId, t.title, r.run_id AS runId,
      r.completed_at AS completedAt,
      json_extract(t.payload_json, '$.settledAt') AS currentSettledAt,
      e.sequence AS settlementSequence,
      json_extract(e.payload_json, '$.settledAt') AS settledAt,
      COALESCE(
        (SELECT json_extract(link.payload_json, '$.parentThreadId')
         FROM orchestration_events link
         WHERE link.application_event_version = 2 AND link.aggregate_kind = 'thread'
           AND link.stream_id = t.thread_id AND link.sequence <= e.sequence
           AND json_type(link.payload_json, '$.parentThreadId') IS NOT NULL
         ORDER BY link.sequence DESC LIMIT 1),
        (SELECT json_extract(link.payload_json, '$.lineage.parentThreadId')
         FROM orchestration_events link
         WHERE link.application_event_version = 2 AND link.aggregate_kind = 'thread'
           AND link.stream_id = t.thread_id AND link.sequence <= e.sequence
           AND json_type(link.payload_json, '$.lineage.parentThreadId') IS NOT NULL
         ORDER BY link.sequence DESC LIMIT 1)
      ) AS parentThreadId
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
    JOIN orchestration_command_receipts receipt
      ON receipt.command_id = 'server:sub-run-settle:' || t.thread_id || ':' || r.run_id
      AND receipt.aggregate_kind = 'thread'
      AND receipt.aggregate_id = t.thread_id
      AND receipt.command_type = 'thread.sub-run.settle'
    JOIN orchestration_events e
      ON e.command_id = receipt.command_id AND e.aggregate_kind = 'thread'
      AND e.stream_id = t.thread_id AND e.application_event_version = 2
      AND e.event_type = 'thread.settled'
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.settledOverride') = 'settled'
      AND r.status IN ('completed', 'failed', 'cancelled')
      AND r.completed_at IS NOT NULL AND r.completed_at >= ?
      AND json_extract(t.payload_json, '$.settledAt') = json_extract(e.payload_json, '$.settledAt')
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events later
        WHERE later.application_event_version = 2 AND later.aggregate_kind = 'thread'
          AND later.stream_id = t.thread_id
          AND later.event_type IN (${LIFECYCLE_EVENTS})
          AND later.sequence > e.sequence
      )
    ORDER BY r.completed_at DESC
  `)
    .all(since);

  return rows.flatMap((row) => {
    const completedAt = String(row.completedAt);
    const settledAt = typeof row.settledAt === "string" ? row.settledAt : "";
    const delta = Date.parse(settledAt) - Date.parse(completedAt);
    if (!Number.isFinite(delta) || delta < 0 || delta > withinMs) return [];

    const parentThreadId = typeof row.parentThreadId === "string" ? row.parentThreadId : null;
    if (parentThreadId !== null) {
      const parent = db
        .prepare(`
        SELECT event_type AS eventType, payload_json AS payloadJson
        FROM orchestration_events
        WHERE application_event_version = 2 AND aggregate_kind = 'thread'
          AND stream_id = ? AND sequence < ?
          AND event_type IN (${LIFECYCLE_EVENTS})
        ORDER BY sequence DESC LIMIT 1
      `)
        .get(parentThreadId, row.settlementSequence);
      if (parent?.eventType === "thread.settled") {
        const payload = JSON.parse(String(parent.payloadJson)) as { settledAt?: unknown };
        if (payload.settledAt === settledAt) return [];
      }
    }

    return [
      {
        threadId: String(row.threadId),
        title: String(row.title),
        runId: String(row.runId),
        completedAt,
        settledAt,
      },
    ];
  });
}

function readArgs(argv: readonly string[]) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const reviewedThreadIds: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--thread-id") {
      const threadId = argv[index + 1];
      if (!threadId) throw new Error("--thread-id requires an ID.");
      reviewedThreadIds.push(threadId);
      index++;
    }
  }
  return {
    apply: argv.includes("--apply"),
    sinceDays: Number(value("--since-days") ?? 7),
    reviewedThreadIds: [...new Set(reviewedThreadIds)],
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function unwrapToolResult(value: unknown): Record<string, unknown> | null {
  const result = objectValue(value);
  if (result?.isError === true) throw new Error("The server rejected the recovery command.");
  const structured = objectValue(result?.structuredContent);
  if (structured !== null) return structured;
  const content = result?.content;
  if (!Array.isArray(content)) return result;
  const text = content.find((block) => objectValue(block)?.type === "text");
  const body = objectValue(text)?.text;
  if (typeof body !== "string") return result;
  try {
    return objectValue(JSON.parse(body));
  } catch {
    return result;
  }
}

export async function applyReviewedCandidates(input: {
  readonly candidates: readonly RecoveryCandidate[];
  readonly reviewedThreadIds: readonly string[];
  readonly callTool: (tool: string, arguments_: Record<string, unknown>) => Promise<unknown>;
}): Promise<ReadonlyArray<{ readonly threadId: string; readonly result: unknown }>> {
  if (input.reviewedThreadIds.length === 0)
    throw new Error("Apply requires at least one explicitly reviewed thread ID.");
  const selected = new Map(input.candidates.map((candidate) => [candidate.threadId, candidate]));
  const missing = input.reviewedThreadIds.filter((threadId) => !selected.has(threadId));
  if (missing.length > 0)
    throw new Error(
      `These reviewed IDs are not current recovery candidates: ${missing.join(", ")}`,
    );

  const results = [];
  for (const threadId of input.reviewedThreadIds) {
    const candidate = selected.get(threadId)!;
    const latest = unwrapToolResult(await input.callTool("t3_thread_read", { threadId }));
    const thread = objectValue(latest?.thread);
    if (thread?.settled !== true || thread.settledAt !== candidate.settledAt) continue;
    const result = await input.callTool("t3_thread_organize", { threadId, action: "unsettle" });
    unwrapToolResult(result);
    results.push({ threadId, result });
  }
  return results;
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (!Number.isFinite(options.sinceDays) || options.sinceDays <= 0)
    throw new Error("--since-days must be positive.");
  if (!options.apply && options.reviewedThreadIds.length > 0)
    throw new Error("--thread-id is only valid with --apply.");
  if (options.apply && options.reviewedThreadIds.length === 0)
    throw new Error("Apply requires at least one explicitly reviewed --thread-id.");

  const dbPath = process.env.T3_RECOVERY_DB;
  if (!dbPath) throw new Error("Set T3_RECOVERY_DB to the environment's statev2.sqlite path.");
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  let candidates: RecoveryCandidate[];
  try {
    candidates = selectRecoveryCandidates(db, {
      nowMs: DateTime.toEpochMillis(await Effect.runPromise(DateTime.now)),
      sinceDays: options.sinceDays,
    });
  } finally {
    db.close();
  }

  process.stdout.write(
    `${JSON.stringify({ mode: options.apply ? "apply" : "dry-run", candidates }, null, 2)}\n`,
  );
  if (!options.apply) return;

  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (!endpoint || !authorization)
    throw new Error(
      "Apply requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION for the same environment as the database.",
    );

  const results = await applyReviewedCandidates({
    candidates,
    reviewedThreadIds: options.reviewedThreadIds,
    callTool: (tool, arguments_) =>
      Effect.runPromise(
        callAcpMcpTool({
          endpoint,
          authorization,
          tool,
          arguments: arguments_,
        }),
      ),
  });
  for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
