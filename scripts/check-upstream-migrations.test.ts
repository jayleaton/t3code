import { assert, it } from "@effect/vitest";

import {
  findMigrationDivergence,
  findStaleManifest,
  parseMigrationEntries,
} from "./check-upstream-migrations.ts";

const manifest = [
  [1, "OrchestrationEvents"],
  [2, "ShellStopRequestIndex"],
] as const;
const none = new Map<number, number>();

it("reads upstream-style entries and ignores the fork ledger's tuples", () => {
  const source = `
    const migrationEntries = [
      [1, "OrchestrationEvents", Migration0001],
      [2, "ShellStopRequestIndex", Migration0002],
    ] as const;
    const forkMigrationEntries = [[1, "ScheduledTasks", ForkMigration001, 2]] as const;
  `;
  assert.deepStrictEqual(parseMigrationEntries(source), manifest);
});

it("accepts upstream ids with fork migrations kept elsewhere", () => {
  assert.deepStrictEqual(findMigrationDivergence(manifest, [...manifest, [3, "Fork"]], none), []);
});

it("rejects renumbered, renamed and removed upstream migrations", () => {
  assert.deepStrictEqual(
    findMigrationDivergence(
      manifest,
      [
        [2, "ForkOnly"],
        [4, "ShellStopRequestIndex"],
      ],
      none,
    ),
    [
      "upstream 1_OrchestrationEvents is missing (renamed or removed). Keep upstream migrations at upstream's id and name; put fork migrations in the fork ledger.",
      "upstream 2_ShellStopRequestIndex was renumbered to 4, and 2 now runs ForkOnly. Keep upstream migrations at upstream's id and name; put fork migrations in the fork ledger.",
    ],
  );
});

it("allows a known renumbering only until it is restored", () => {
  const known = new Map([[2, 4]]);
  const renumbered = [
    [1, "OrchestrationEvents"],
    [4, "ShellStopRequestIndex"],
  ] as const;
  assert.deepStrictEqual(findMigrationDivergence(manifest, renumbered, known), []);
  assert.deepStrictEqual(findMigrationDivergence(manifest, manifest, known), [
    "upstream 2_ShellStopRequestIndex is back at its upstream id; delete 2 from KNOWN_RENUMBERED in scripts/check-upstream-migrations.ts.",
  ]);
});

it("flags a manifest that disagrees with upstream or misses a synced migration", () => {
  const upstream = [...manifest, [3, "NewUpstream"]] as const;
  assert.deepStrictEqual(findStaleManifest(manifest, upstream, manifest), []);
  const problems = findStaleManifest(
    [
      [1, "OrchestrationEvents"],
      [2, "Edited"],
    ],
    upstream,
    [...manifest, [3, "NewUpstream"]],
  );
  assert.strictEqual(problems.length, 2);
  assert.match(problems[0]!, /lists 2_Edited, but upstream has 2_ShellStopRequestIndex/);
  assert.match(problems[1]!, /synced upstream 3_NewUpstream, but .* does not list it/);
});
