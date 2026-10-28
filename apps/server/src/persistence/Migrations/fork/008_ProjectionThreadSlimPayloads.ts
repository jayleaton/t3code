import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Skill-free copies keep shell, settlement and cleanup reads off large overflow pages.
 * Triggers cover every write path and must delete before inserting: a triggering upsert's
 * conflict policy overrides INSERT OR REPLACE and would turn it into ABORT. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_v2_projection_thread_slim_payloads (
      thread_id TEXT PRIMARY KEY,
      provider_instance_id TEXT,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_thread_slim_payloads_insert
    AFTER INSERT ON orchestration_v2_projection_threads
    BEGIN
      DELETE FROM orchestration_v2_projection_thread_slim_payloads
      WHERE thread_id = NEW.thread_id;
      INSERT INTO orchestration_v2_projection_thread_slim_payloads
        (thread_id, provider_instance_id, payload_json)
      VALUES (
        NEW.thread_id,
        NEW.provider_instance_id,
        json_remove(NEW.payload_json, '$.profileSnapshot.skills')
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_thread_slim_payloads_update
    AFTER UPDATE OF thread_id, payload_json, provider_instance_id
    ON orchestration_v2_projection_threads
    BEGIN
      DELETE FROM orchestration_v2_projection_thread_slim_payloads
      WHERE thread_id IN (OLD.thread_id, NEW.thread_id);
      INSERT INTO orchestration_v2_projection_thread_slim_payloads
        (thread_id, provider_instance_id, payload_json)
      VALUES (
        NEW.thread_id,
        NEW.provider_instance_id,
        json_remove(NEW.payload_json, '$.profileSnapshot.skills')
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_v2_projection_thread_slim_payloads_delete
    AFTER DELETE ON orchestration_v2_projection_threads
    BEGIN
      DELETE FROM orchestration_v2_projection_thread_slim_payloads
      WHERE thread_id = OLD.thread_id;
    END
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_thread_slim_payloads
      (thread_id, provider_instance_id, payload_json)
    SELECT thread_id, provider_instance_id, json_remove(payload_json, '$.profileSnapshot.skills')
    FROM orchestration_v2_projection_threads
  `;
});
