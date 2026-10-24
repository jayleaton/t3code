#!/usr/bin/env node
// Fails when a patchedDependencies entry is not pinned to the exact version it patches.
// Release Smoke installs without the lockfile, so a range lets pnpm resolve a newer
// release, the patch goes unused, and the install fails with ERR_PNPM_UNUSED_PATCH.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const StringRecord = Schema.Record(Schema.String, Schema.String);

const WorkspaceConfig = Schema.Struct({
  packages: Schema.Array(Schema.String),
  catalog: Schema.optional(StringRecord),
  overrides: Schema.optional(StringRecord),
  patchedDependencies: Schema.optional(StringRecord),
});

const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(StringRecord),
  devDependencies: Schema.optional(StringRecord),
  optionalDependencies: Schema.optional(StringRecord),
});

const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const decodePackageManifest = Schema.decodeEffect(Schema.fromJsonString(PackageManifest));

export interface WorkspaceManifest {
  readonly path: string;
  readonly dependencies: Record<string, string>;
}

export interface PatchPinInput {
  readonly patchedDependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly catalog: Record<string, string>;
  readonly manifests: ReadonlyArray<WorkspaceManifest>;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function splitPatchKey(key: string): { readonly name: string; readonly version: string | null } {
  const versionIndex = key.indexOf("@", 1);
  return versionIndex === -1
    ? { name: key, version: null }
    : { name: key.slice(0, versionIndex), version: key.slice(versionIndex + 1) };
}

function resolveSpec(name: string, spec: string, catalog: Record<string, string>, owner: string) {
  return resolveCatalogDependencies({ [name]: spec }, catalog, owner)[name] ?? spec;
}

/** Returns one message per patched package that a lockfile-free install could move past. */
export function findUnpinnedPatches(input: PatchPinInput): ReadonlyArray<string> {
  const problems: Array<string> = [];
  for (const key of Object.keys(input.patchedDependencies)) {
    const { name, version } = splitPatchKey(key);
    const fix = (pin: string) =>
      `fix: add \`"${name}": ${pin}\` under \`overrides:\` in pnpm-workspace.yaml, next to its patchedDependencies entry.`;
    if (version === null || !EXACT_VERSION.test(version)) {
      problems.push(
        `${key}: the patch is not keyed to one exact version, so it cannot be pinned; ` +
          `rename it to \`${name}@<version>\` and ${fix("<version>")}`,
      );
      continue;
    }

    const override = input.overrides[name];
    if (override !== undefined) {
      const pinned = resolveSpec(name, override, input.catalog, "pnpm-workspace.yaml overrides");
      if (pinned !== version) {
        problems.push(
          `${key}: overrides pins ${name} to ${pinned}, not the patched ${version}; ` +
            `update the override and the patch together (${fix(version)})`,
        );
      }
      continue;
    }

    const declarations = input.manifests.flatMap((manifest) => {
      const spec = manifest.dependencies[name];
      return spec === undefined
        ? []
        : [{ path: manifest.path, spec: resolveSpec(name, spec, input.catalog, manifest.path) }];
    });
    if (declarations.length === 0) {
      problems.push(
        `${key}: only reached as a transitive dependency, so nothing pins it; ${fix(version)}`,
      );
      continue;
    }
    const loose = declarations.filter((declaration) => declaration.spec !== version);
    if (loose.length > 0) {
      const where = loose.map(
        (declaration) => `${declaration.path} declares "${declaration.spec}"`,
      );
      problems.push(`${key}: ${where.join(", ")}; ${fix(version)}`);
    }
  }
  return problems;
}

class UnpinnedPatchError extends Schema.TaggedError<UnpinnedPatchError>()("UnpinnedPatchError", {
  problems: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return [
      "Patched dependencies must be pinned to the exact version their patch targets.",
      "Release installs run without the lockfile and otherwise fail with ERR_PNPM_UNUSED_PATCH once a newer version ships.",
      ...this.problems.map((problem) => `  - ${problem}`),
    ].join("\n");
  }
}

const readWorkspaceManifests = Effect.fn("readWorkspaceManifests")(function* (
  repoRoot: string,
  packageGlobs: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directories = [""];
  for (const glob of packageGlobs) {
    if (glob.endsWith("/*")) {
      const parent = glob.slice(0, -2);
      const entries = yield* fs.readDirectory(path.join(repoRoot, parent));
      directories.push(...entries.map((entry) => `${parent}/${entry}`));
    } else {
      directories.push(glob);
    }
  }

  const manifests: Array<WorkspaceManifest> = [];
  for (const directory of directories.toSorted()) {
    const manifestPath = path.join(directory, "package.json");
    if (!(yield* fs.exists(path.join(repoRoot, manifestPath)))) continue;
    const manifest = yield* decodePackageManifest(
      yield* fs.readFileString(path.join(repoRoot, manifestPath)),
    );
    manifests.push({
      path: manifestPath,
      dependencies: {
        ...manifest.optionalDependencies,
        ...manifest.devDependencies,
        ...manifest.dependencies,
      },
    });
  }
  return manifests;
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const workspace = yield* decodeWorkspaceConfig(
    yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml")),
  );
  const problems = findUnpinnedPatches({
    patchedDependencies: workspace.patchedDependencies ?? {},
    overrides: workspace.overrides ?? {},
    catalog: workspace.catalog ?? {},
    manifests: yield* readWorkspaceManifests(repoRoot, workspace.packages),
  });
  if (problems.length > 0) {
    return yield* new UnpinnedPatchError({ problems });
  }
  yield* Effect.log(
    `All ${Object.keys(workspace.patchedDependencies ?? {}).length} patched dependencies are pinned.`,
  );
});

if (import.meta.main) {
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
