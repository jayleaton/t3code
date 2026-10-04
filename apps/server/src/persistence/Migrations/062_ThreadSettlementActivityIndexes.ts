import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The idle sweep needs the last background update, including completed work,
  // without scanning a card's full history every minute.
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_turn_items_activity_idx
    ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS orchestration_v2_provider_threads_activity_idx
    ON orchestration_v2_projection_provider_threads(thread_id, updated_at DESC)`;
});
