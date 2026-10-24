import { assert, it } from "@effect/vitest";

import { findUnpinnedPatches } from "./check-patch-pins.ts";

const nodePtyPatch = { "node-pty@1.2.0-beta.15": "patches/node-pty@1.2.0-beta.15.patch" };
const serverManifest = (spec: string) => ({
  path: "apps/server/package.json",
  dependencies: { "node-pty": spec },
});

it("rejects a manifest range that a newer release satisfies, and names the override fix", () => {
  const problems = findUnpinnedPatches({
    patchedDependencies: nodePtyPatch,
    overrides: {},
    catalog: {},
    manifests: [serverManifest("^1.2.0-beta.15")],
  });

  assert.deepStrictEqual(problems, [
    'node-pty@1.2.0-beta.15: apps/server/package.json declares "^1.2.0-beta.15"; fix: add `"node-pty": 1.2.0-beta.15` under `overrides:` in pnpm-workspace.yaml, next to its patchedDependencies entry.',
  ]);
});

it("accepts an exact override, including one resolved through the catalog", () => {
  assert.deepStrictEqual(
    findUnpinnedPatches({
      patchedDependencies: { ...nodePtyPatch, "effect@4.0.5": "patches/effect@4.0.5.patch" },
      overrides: { "node-pty": "1.2.0-beta.15", effect: "catalog:" },
      catalog: { effect: "4.0.5" },
      manifests: [serverManifest("^1.2.0-beta.15")],
    }),
    [],
  );
});

it("accepts exact manifest pins without an override", () => {
  assert.deepStrictEqual(
    findUnpinnedPatches({
      patchedDependencies: nodePtyPatch,
      overrides: {},
      catalog: {},
      manifests: [serverManifest("1.2.0-beta.15")],
    }),
    [],
  );
});

it("rejects transitive-only patches, stale overrides and unversioned patch keys", () => {
  const problems = findUnpinnedPatches({
    patchedDependencies: {
      "mdast-util-math@3.0.0": "patches/mdast-util-math@3.0.0.patch",
      "dbus-next@0.10.2": "patches/dbus-next@0.10.2.patch",
      "@scope/any": "patches/@scope__any.patch",
    },
    overrides: { "dbus-next": "0.10.3" },
    catalog: {},
    manifests: [],
  });

  assert.strictEqual(problems.length, 3);
  assert.match(problems[0]!, /^mdast-util-math@3\.0\.0: only reached as a transitive dependency/);
  assert.match(problems[1]!, /^dbus-next@0\.10\.2: overrides pins dbus-next to 0\.10\.3/);
  assert.match(problems[2]!, /^@scope\/any: the patch is not keyed to one exact version/);
});
