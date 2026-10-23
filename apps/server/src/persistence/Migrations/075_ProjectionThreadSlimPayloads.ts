import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Agent threads snapshot their profile's skills, about 130 KB per thread and
 * nearly all of each payload. Shell, settlement, and cleanup reads drop them,
 * but still read every overflow page of every thread row to do it, which on a
 * large database turns each client connect into hundreds of MB of I/O.
 * Triggers keep a copy without skills, so those reads stay off the big rows
 * and no write path has to remember it. The triggers delete before inserting:
 * a trigger's INSERT takes the conflict policy of the statement that fired it,
 * so the projection's upserts would turn INSERT OR REPLACE into ABORT.
 */
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
