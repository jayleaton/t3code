import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { profileSnapshotContentHash } from "../../../orchestration-v2/ProfileSnapshotContent.ts";
import { runMigrations } from "../../Migrations.ts";
import * as OrchestrationEventStore from "../../OrchestrationEventStore.ts";

const layer = it.layer(
  OrchestrationEventStore.layer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  ),
);

const at = "2026-10-24T00:00:00.000Z";
const skill = (name: string) => ({
  skillId: name,
  name,
  description: "Rules",
  content: `${name} body`,
  revision: 1,
  createdAt: at,
  updatedAt: at,
});
const effectiveSource = {
  modelSelection: "profile",
  runtimeMode: "profile",
  interactionMode: "profile",
  reasoningEffort: "profile",
} as const;
const reviewer = { systemPrompt: "Review every change.", skills: [skill("review")] };
const writer = { systemPrompt: "Write the docs.", skills: [skill("docs")] };

const legacyThread = (threadId: string, content: typeof reviewer) => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: "project",
  title: threadId,
  profileSnapshot: {
    ...content,
    profileId: "agent",
    profileName: "Agent",
    revision: 1,
    effectiveSource,
  },
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

layer("fork/011_ProfileSnapshots", (it) => {
  it.effect("moves inline profile content into hashed rows that legacy events resolve to", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* runMigrations({ toForkMigrationInclusive: 10 });

      // A projected thread, and a created thread whose projection was never written.
      const projected = JSON.stringify(legacyThread("thread-projected", reviewer));
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json, provider_instance_id)
        VALUES ('thread-projected', 'project', 'projected', 'codex', 'full-access', 'default',
          ${at}, ${at}, ${projected}, 'codex')
      `;
      const insertEvent = (threadId: string, version: number, type: string, payload: string) => sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`${threadId}:${version}`}, 'thread', ${threadId}, ${version}, ${type},
          ${at}, 'server', ${payload}, '{}', 2
        )
      `;
      yield* insertEvent("thread-projected", 0, "thread.created", projected);
      yield* insertEvent("thread-projected", 1, "thread.visited", projected);
      yield* insertEvent(
        "thread-unprojected",
        0,
        "thread.created",
        JSON.stringify(legacyThread("thread-unprojected", writer)),
      );

      yield* runMigrations();

      const stored = yield* sql<{ readonly content_hash: string; readonly content_json: string }>`
        SELECT content_hash, content_json FROM profile_snapshots ORDER BY content_hash
      `;
      assert.deepEqual(
        stored.map((row) => [row.content_hash, JSON.parse(row.content_json)]),
        [
          [profileSnapshotContentHash(reviewer), reviewer],
          [profileSnapshotContentHash(writer), writer],
        ].toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      );

      const [row] = yield* sql<{ readonly snapshot_json: string }>`
        SELECT json_extract(payload_json, '$.profileSnapshot') AS snapshot_json
        FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-projected'
      `;
      const snapshot = JSON.parse(row!.snapshot_json);
      assert.equal(snapshot.contentHash, profileSnapshotContentHash(reviewer));
      assert.notProperty(snapshot, "systemPrompt");
      assert.notProperty(snapshot, "skills");

      const slimTables = yield* sql`
        SELECT name FROM sqlite_master WHERE name LIKE 'orchestration_v2_projection_thread_slim%'
      `;
      assert.deepEqual(slimTables, []);

      // Stored events keep their inline copies and decode to the stored rows' hashes.
      for (const [threadId, content] of [
        ["thread-projected", reviewer],
        ["thread-unprojected", writer],
      ] as const) {
        const decoded = yield* Stream.runCollect(
          events.readAgentEvents({ threadId: ThreadId.make(threadId) }),
        );
        assert.isNotEmpty(decoded);
        for (const { event } of decoded) {
          assert.deepInclude(event.payload, {
            profileSnapshot: {
              profileId: "agent",
              profileName: "Agent",
              revision: 1,
              effectiveSource,
              contentHash: profileSnapshotContentHash(content),
            },
          });
        }
      }
    }),
  );
});
