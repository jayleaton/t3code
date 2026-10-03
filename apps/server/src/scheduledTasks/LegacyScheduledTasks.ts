import {
  DEFAULT_MODEL,
  DEFAULT_RUNTIME_MODE,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProviderInstanceId,
  ScheduledTaskSchedule,
  type ScheduledTaskRunStatus,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface LegacyScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly profile_id: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly schedule_json: string;
  readonly enabled: number;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string | null;
  readonly last_run_error: string | null;
  readonly run_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Fork V1 schedules used `kind`; V2 uses `type` with the same fields. */
const decodeLegacySchedule = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("cron"),
        expression: Schema.String,
        timezone: Schema.String,
      }),
      Schema.Struct({ kind: Schema.Literal("once"), runAt: Schema.String }),
    ]),
  ),
);
const encodeSchedule = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskSchedule));
const encodeWorkspaceStrategy = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy),
);
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));

function legacySchedule(json: string): ScheduledTaskSchedule | null {
  const legacy = Option.getOrNull(decodeLegacySchedule(json));
  if (legacy === null) return null;
  return legacy.kind === "cron"
    ? { type: "cron", expression: legacy.expression, timezone: legacy.timezone }
    : { type: "once", runAt: legacy.runAt };
}

const legacyStatus = (status: string | null): ScheduledTaskRunStatus =>
  status === "sent" ? "succeeded" : status === "failed" ? "failed" : "never";

/**
 * Moves tasks created by fork V1 releases (migration 56) into the V2 table, then drops the
 * legacy table. Runs resolve the profile at launch, so the stored model and modes are only a
 * snapshot of the profile for clients that display them.
 */
export const importLegacyScheduledTasks = Effect.fn("importLegacyScheduledTasks")(function* (
  settings: ServerSettings | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_scheduled_tasks'
  `;
  if (tables.length === 0) return 0;
  const rows = yield* sql<LegacyScheduledTaskRow>`SELECT * FROM legacy_scheduled_tasks`;
  const fallbackModel: ModelSelection = settings?.defaultModelSelection ?? {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  };
  let imported = 0;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of rows) {
        const schedule = legacySchedule(row.schedule_json);
        if (schedule === null) {
          yield* Effect.logWarning("Skipping legacy scheduled task with an unknown schedule", {
            taskId: row.task_id,
          });
          continue;
        }
        const profile = settings?.mcpGatewayProfiles.find(
          (candidate) => candidate.profileId === row.profile_id,
        );
        const runtimeMode =
          profile === undefined || profile.runtimeMode === "read-only"
            ? DEFAULT_RUNTIME_MODE
            : profile.runtimeMode;
        yield* sql`
          INSERT OR IGNORE INTO scheduled_tasks ${sql.insert({
            task_id: row.task_id,
            title: row.title,
            prompt: row.prompt,
            enabled: row.enabled,
            schedule_json: encodeSchedule(schedule),
            project_id: row.project_id,
            thread_id: row.thread_id,
            profile_id: row.profile_id,
            workspace_strategy_json: encodeWorkspaceStrategy({ type: "root" }),
            model_selection_json: encodeModelSelection(profile?.modelSelection ?? fallbackModel),
            runtime_mode: runtimeMode,
            interaction_mode: profile?.interactionMode ?? "default",
            created_by: "user",
            creation_source: "web",
            created_at: row.created_at,
            updated_at: row.updated_at,
            next_run_at: row.next_run_at,
            last_run_at: row.last_run_at,
            last_run_status: legacyStatus(row.last_run_status),
            last_run_error: row.last_run_error,
            run_count: row.run_count,
          })}
        `;
        imported += 1;
      }
      yield* sql`DROP TABLE legacy_scheduled_tasks`;
    }),
  );
  return imported;
});
