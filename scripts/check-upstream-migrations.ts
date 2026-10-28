#!/usr/bin/env node
// Effect compares migration IDs only: renumbering makes fork/upstream databases incompatible.
// Default: check the manifest; --upstream <file>: also compare upstream; --sync <git-ref>: regenerate it.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Command, Flag } from "effect/cli";
import * as Option from "effect/Option";

export type MigrationEntry = readonly [id: number, name: string];

const MIGRATIONS_PATH = "apps/server/src/persistence/Migrations.ts";
const MANIFEST_PATH = "scripts/upstream-migrations.json";
const SYNC_COMMAND = "node scripts/check-upstream-migrations.ts --sync upstream/main";

/**
 * Upstream id -> fork id for upstream migrations the fork ledger still runs under another id.
 * Restoring upstream's ids (fix/fork-migration-ledger) empties this list; do not add to it.
 */
export const KNOWN_RENUMBERED: ReadonlyMap<number, number> = new Map();

// Upstream entries are `[id, "Name", Migration00NN]`. The fork's own ledger uses other
// tuple shapes, so only upstream-style entries are read.
const UPSTREAM_ENTRY = /\[\s*(\d+),\s*"(\w+)",\s*Migration\d+\s*\]/g;

export function parseMigrationEntries(source: string): ReadonlyArray<MigrationEntry> {
  return Array.from(source.matchAll(UPSTREAM_ENTRY), (match) => [Number(match[1]), match[2]!]);
}

/** Problems with the fork's Migrations.ts relative to the upstream manifest. */
export function findMigrationDivergence(
  manifest: ReadonlyArray<MigrationEntry>,
  fork: ReadonlyArray<MigrationEntry>,
  knownRenumbered: ReadonlyMap<number, number> = KNOWN_RENUMBERED,
): ReadonlyArray<string> {
  const forkNameById = new Map(fork);
  const forkIdsByName = new Map<string, Array<number>>();
  for (const [id, name] of fork) forkIdsByName.set(name, [...(forkIdsByName.get(name) ?? []), id]);

  const problems: Array<string> = [];
  for (const [id, name] of manifest) {
    const known = knownRenumbered.get(id);
    if (forkNameById.get(id) === name) {
      if (known !== undefined) {
        problems.push(
          `upstream ${id}_${name} is back at its upstream id; delete ${id} from KNOWN_RENUMBERED in scripts/check-upstream-migrations.ts.`,
        );
      }
      continue;
    }
    if (known !== undefined && forkNameById.get(known) === name) continue;

    const movedTo = forkIdsByName.get(name);
    const occupant = forkNameById.get(id);
    const where =
      movedTo === undefined
        ? "is missing (renamed or removed)"
        : `was renumbered to ${movedTo.join(", ")}`;
    const taken = occupant === undefined ? "" : `, and ${id} now runs ${occupant}`;
    problems.push(
      `upstream ${id}_${name} ${where}${taken}. Keep upstream migrations at upstream's id and name; put fork migrations in the fork ledger.`,
    );
  }
  return problems;
}

/** Problems with the checked-in manifest relative to upstream's Migrations.ts. */
export function findStaleManifest(
  manifest: ReadonlyArray<MigrationEntry>,
  upstream: ReadonlyArray<MigrationEntry>,
  fork: ReadonlyArray<MigrationEntry>,
): ReadonlyArray<string> {
  const upstreamNameById = new Map(upstream);
  const manifestIds = new Set(manifest.map(([id]) => id));
  const forkNames = new Set(fork.map(([, name]) => name));
  const problems: Array<string> = [];
  for (const [id, name] of manifest) {
    const upstreamName = upstreamNameById.get(id);
    if (upstreamName !== name) {
      problems.push(
        `${MANIFEST_PATH} lists ${id}_${name}, but upstream has ${upstreamName === undefined ? "no migration" : `${id}_${upstreamName}`} there; regenerate it with \`${SYNC_COMMAND}\`.`,
      );
    }
  }
  for (const [id, name] of upstream) {
    if (!manifestIds.has(id) && forkNames.has(name)) {
      problems.push(
        `the fork has synced upstream ${id}_${name}, but ${MANIFEST_PATH} does not list it; run \`${SYNC_COMMAND}\`.`,
      );
    }
  }
  return problems;
}

class MigrationDivergenceError extends Schema.TaggedError<MigrationDivergenceError>()(
  "MigrationDivergenceError",
  { problems: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return [
      "Upstream migrations diverged from pingdotgg/t3code:",
      ...this.problems.map((problem) => `  - ${problem}`),
    ].join("\n");
  }
}

const Manifest = Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.Int, Schema.String])));
const decodeManifest = Schema.decodeEffect(Manifest);

const readGitFile = Effect.fn("readGitFile")(function* (ref: string, file: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(ChildProcess.make("git", ["show", `${ref}:${file}`]));
});

const command = Command.make(
  "check-upstream-migrations",
  {
    upstream: Flag.String("upstream").pipe(
      Flag.withDescription("Path to upstream's Migrations.ts, to verify the manifest itself."),
      Flag.optional,
    ),
    sync: Flag.String("sync").pipe(
      Flag.withDescription("Git ref of upstream to regenerate the manifest from."),
      Flag.optional,
    ),
  },
  Effect.fn("checkUpstreamMigrations")(function* ({ upstream, sync }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const manifestFile = path.join(repoRoot, MANIFEST_PATH);

    if (Option.isSome(sync)) {
      const entries = parseMigrationEntries(yield* readGitFile(sync.value, MIGRATIONS_PATH));
      yield* fs.writeFileString(
        manifestFile,
        `[\n${entries.map(([id, name]) => `  [${id}, ${JSON.stringify(name)}]`).join(",\n")}\n]\n`,
      );
      return yield* Effect.log(`Wrote ${entries.length} upstream migrations from ${sync.value}.`);
    }

    const manifest = yield* decodeManifest(yield* fs.readFileString(manifestFile));
    const fork = parseMigrationEntries(
      yield* fs.readFileString(path.join(repoRoot, MIGRATIONS_PATH)),
    );
    const problems = [...findMigrationDivergence(manifest, fork)];
    if (Option.isSome(upstream)) {
      const upstreamEntries = parseMigrationEntries(yield* fs.readFileString(upstream.value));
      problems.push(...findStaleManifest(manifest, upstreamEntries, fork));
    }
    if (problems.length > 0) return yield* new MigrationDivergenceError({ problems });
    yield* Effect.log(
      `All ${manifest.length} upstream migrations keep their ids (${KNOWN_RENUMBERED.size} known exceptions).`,
    );
  }),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
