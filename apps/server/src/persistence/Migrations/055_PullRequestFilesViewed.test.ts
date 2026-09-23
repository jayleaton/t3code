import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("055_PullRequestFilesViewed", (it) => {
  it.effect(
    "adds viewed files after the shipped fork migrations and preserves marks on rerun",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* runMigrations();
        yield* sql`INSERT INTO pull_request_files_viewed
        (provider, host, repository, number, viewer, path, revision, viewed_at)
        VALUES ('github', 'github.com', 'jayleaton/t3code', 1, 'reader', 'README.md', 'abc', '2026-09-20T00:00:00Z')`;
        assert.deepEqual(yield* runMigrations(), []);
        const rows = yield* sql`SELECT path, revision FROM pull_request_files_viewed`;
        assert.deepEqual(rows, [{ path: "README.md", revision: "abc" }]);
      }),
  );
});
