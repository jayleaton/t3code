import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  splitLegacyProfileSnapshot,
  storeProfileSnapshotContent,
} from "../../../orchestration-v2/ProfileSnapshotContent.ts";

const PAGE_SIZE = 100;
const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(JsonValue);
const encodeJson = Schema.encodeUnknownEffect(JsonValue);

const carriesProfileContent = (column: string) =>
  `(json_type(${column}, '$.profileSnapshot.skills') IS NOT NULL
    OR json_type(${column}, '$.profileSnapshot.systemPrompt') IS NOT NULL)`;

/**
 * Agent instructions and skills move out of thread payloads into content-addressed rows, so
 * whole-thread events and bulk thread reads stop carrying ~130 KB per agent thread.
 *
 * Existing thread events keep their inline copies and decode by hashing them
 * (`withoutLegacyProfileContent`), so every one of them needs its row here. A thread's
 * profile is frozen at creation and every later thread event repeats it, so storing what
 * the projection holds, plus each `thread.created` the projection does not cover, stores
 * all of them. Pages keep one batch of large payloads in memory at a time.
 *
 * Slim payloads make fork migration 8's skill-less copy of each row identical to the row,
 * so its table and triggers go.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE profile_snapshots (
      content_hash TEXT PRIMARY KEY,
      content_json TEXT NOT NULL
    )
  `;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_projection_thread_slim_payloads_insert`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_projection_thread_slim_payloads_update`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_projection_thread_slim_payloads_delete`;
  yield* sql`DROP TABLE IF EXISTS orchestration_v2_projection_thread_slim_payloads`;

  let afterThreadId = "";
  while (true) {
    const rows = yield* sql<{ readonly thread_id: string; readonly snapshot_json: string }>`
      SELECT thread_id, json_extract(payload_json, '$.profileSnapshot') AS snapshot_json
      FROM orchestration_v2_projection_threads
      WHERE thread_id > ${afterThreadId}
        AND ${sql.unsafe(carriesProfileContent("payload_json"))}
      ORDER BY thread_id
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      const split = splitLegacyProfileSnapshot(yield* decodeJson(row.snapshot_json));
      if (split.content !== undefined) yield* storeProfileSnapshotContent(split.content);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(
          payload_json,
          '$.profileSnapshot',
          json(${yield* encodeJson(split.snapshot)})
        )
        WHERE thread_id = ${row.thread_id}
      `;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE_SIZE) break;
    afterThreadId = last.thread_id;
  }

  let afterStreamId = "";
  while (true) {
    const rows = yield* sql<{ readonly stream_id: string; readonly snapshot_json: string }>`
      SELECT event.stream_id, json_extract(event.payload_json, '$.profileSnapshot') AS snapshot_json
      FROM orchestration_events AS event
      WHERE event.application_event_version = 2
        AND event.aggregate_kind = 'thread'
        AND event.event_type = 'thread.created'
        AND event.stream_id > ${afterStreamId}
        AND ${sql.unsafe(carriesProfileContent("event.payload_json"))}
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id = event.stream_id
            AND json_type(thread.payload_json, '$.profileSnapshot.contentHash') IS NOT NULL
        )
      ORDER BY event.stream_id
      LIMIT ${PAGE_SIZE}
    `;
    for (const row of rows) {
      const split = splitLegacyProfileSnapshot(yield* decodeJson(row.snapshot_json));
      if (split.content !== undefined) yield* storeProfileSnapshotContent(split.content);
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < PAGE_SIZE) break;
    afterStreamId = last.stream_id;
  }
});
