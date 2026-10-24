import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export const FORK_MIGRATIONS_TABLE = "effect_sql_fork_migrations";

const FIRST_LEGACY_FORK_ID = 52;

/**
 * What fork builds before the split recorded in `effect_sql_migrations` from
 * id 52 on, upstream and fork migrations interleaved. Ids below 52 mean the
 * same in both layouts.
 */
export const legacyForkLedger = [
  "AgentProfileAndPullRequestCompatibility",
  "RepairAgentUpgradeSchema",
  "ProjectionThreadTitleState",
  "PullRequestFilesViewed",
  "ScheduledTasks",
  "ProjectionThreadsAutoSettleDisabledAt",
  "ProjectionThreadsParentThreadId",
  "OrchestrationV2",
  "RemoveRedundantProjectionIndexes",
  "ProjectionTodos",
  "ThreadSettlementActivityIndexes",
  "ScheduledTaskWebhooks",
  "WebhookRelayDeliveries",
  "ThreadTasks",
  "McpAppModelContext",
  "ThreadSnapshotWindowIndexes",
  "PullRequestReviewGuides",
  "ThreadFailureLookupIndex",
  "DropUnusedV1Projections",
  "CanonicalizeThreadPullRequestLinks",
  "CodexUsageNativeTurnIndex",
  "RepairClientSettlementTimestamps",
  "WebhookDedupe",
  "ProjectionThreadSlimPayloads",
  "ShellStopRequestIndex",
  "ShellRunlessRootTurnIndex",
  "ProjectionThreadParentIndex",
] as const;

// Shipped agent builds recorded 52 as ProjectionThreadListState; fork migration 2 repairs them.
const isLegacyName = (id: number, name: string) =>
  legacyForkLedger[id - FIRST_LEGACY_FORK_ID] === name ||
  (id === FIRST_LEGACY_FORK_ID && name === "ProjectionThreadListState");

interface Manifests {
  readonly upstream: ReadonlyArray<readonly [id: number, name: string]>;
  readonly fork: ReadonlyArray<readonly [id: number, name: string, after: number]>;
}

/**
 * Moves a database from the single ledger fork builds used to write onto
 * upstream ids plus the fork's own table. The migrator treats every id at or
 * below the latest as applied, so the split keeps exactly that set: each
 * migration up to the latest legacy id is recorded at its new id, and nothing
 * re-runs or gets skipped. Databases already split, fresh, or written by
 * upstream (52 is upstream's ProjectionThreadTitleState) are left alone.
 */
export const splitLegacyForkLedger = Effect.fn("splitLegacyForkLedger")(function* (
  manifests: Manifests,
) {
  const sql = yield* SqlClient.SqlClient;
  const upstreamIds = new Map(manifests.upstream.map(([id, name]) => [name, id]));
  const forkIds = new Map(manifests.fork.map(([id, name]) => [name, id]));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('effect_sql_migrations', ${FORK_MIGRATIONS_TABLE})
      `;
      const tableNames = new Set(tables.map((table) => table.name));
      if (!tableNames.has("effect_sql_migrations") || tableNames.has(FORK_MIGRATIONS_TABLE)) {
        return;
      }
      const rows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
        SELECT migration_id, name, created_at FROM effect_sql_migrations
        WHERE migration_id >= ${FIRST_LEGACY_FORK_ID}
        ORDER BY migration_id
      `;
      const [first] = rows;
      if (
        first?.migration_id !== FIRST_LEGACY_FORK_ID ||
        !isLegacyName(first.migration_id, first.name)
      ) {
        return;
      }
      const unexpected = rows.filter((row) => !isLegacyName(row.migration_id, row.name));
      if (unexpected.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `This database's migration history mixes this fork's layout with migrations it does not know: ${unexpected
            .map((row) => `${row.migration_id}_${row.name}`)
            .join(
              ", ",
            )}. It was probably written by an experimental build. Recreate disposable preview state from a released fork snapshot; do not use your live database.`,
        });
      }

      const recorded = new Map(rows.map((row) => [row.migration_id, row]));
      const latest = rows.at(-1)?.migration_id ?? FIRST_LEGACY_FORK_ID;
      const moved = legacyForkLedger
        .slice(0, latest - FIRST_LEGACY_FORK_ID + 1)
        .map((name, index) => {
          const row = recorded.get(FIRST_LEGACY_FORK_ID + index);
          return {
            name,
            recordedName: row?.name ?? name,
            createdAt: row?.created_at ?? null,
          };
        });

      yield* sql`
        DELETE FROM effect_sql_migrations WHERE migration_id >= ${FIRST_LEGACY_FORK_ID}
      `;
      // Same shape the migrator creates, so it adopts this table as is.
      yield* sql`
        CREATE TABLE ${sql(FORK_MIGRATIONS_TABLE)} (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        )
      `;
      for (const { name, recordedName, createdAt } of moved) {
        const upstreamId = upstreamIds.get(name);
        const forkId = forkIds.get(name);
        const [table, id] =
          upstreamId !== undefined
            ? (["effect_sql_migrations", upstreamId] as const)
            : forkId !== undefined
              ? ([FORK_MIGRATIONS_TABLE, forkId] as const)
              : [undefined, undefined];
        if (table === undefined) {
          return yield* Effect.die(`Legacy migration ${name} is in neither ledger`);
        }
        yield* sql`
          INSERT INTO ${sql(table)} (migration_id, name, created_at)
          VALUES (${id}, ${recordedName}, COALESCE(${createdAt}, CURRENT_TIMESTAMP))
        `;
      }
      yield* Effect.log("Split the fork's migration history from upstream's").pipe(
        Effect.annotateLogs({ latestLegacyMigrationId: latest }),
      );
    }),
  );
});
