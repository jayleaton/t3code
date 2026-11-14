// @effect-diagnostics nodeBuiltinImport:off - fixtures are plain temp directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import { findRemovedConnectProblems, readManifestPaths } from "./check-removed-connect.ts";

const fixture = (files: Readonly<Record<string, string>>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-removed-connect-"));
  for (const [file, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), text);
  }
  return {
    root,
    files: Object.keys(files),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true }),
  };
};

it("passes a tree without removed paths or Clerk", () => {
  using repo = fixture({
    "apps/web/src/main.ts": 'import { thing } from "@t3tools/shared/hostedApp";\n',
    "apps/web/package.json": JSON.stringify({ dependencies: { react: "19" } }),
  });
  assert.deepStrictEqual(findRemovedConnectProblems(repo.root, ["infra/relay"], repo.files), []);
});

it("reports a removed directory or file that came back", () => {
  using repo = fixture({
    "infra/relay/src/worker.ts": "export default {};\n",
    "packages/shared/src/relayJwt.ts": "export {};\n",
  });
  const problems = findRemovedConnectProblems(
    repo.root,
    ["infra/relay", "packages/shared/src/relayJwt.ts", "apps/server/src/relay"],
    [],
  );
  assert.deepStrictEqual(problems, [
    "infra/relay was removed from the fork and is back. Delete it.",
    "packages/shared/src/relayJwt.ts was removed from the fork and is back. Delete it.",
  ]);
});

it("reports Clerk imports and dependencies but not mentions or vendored copies", () => {
  using repo = fixture({
    "apps/web/src/a.ts": 'import { useAuth } from "@clerk/react";\n',
    "apps/web/src/b.tsx": 'const clerk = await import("@clerk/clerk-js");\n',
    "apps/desktop/src/c.cjs": 'const passkeys = require("@clerk/electron-passkeys");\n',
    "apps/web/src/d.ts": "// Clerk (@clerk/react) was removed.\n",
    "apps/mobile/package.json": JSON.stringify({ devDependencies: { "@clerk/expo": "4" } }),
    ".repos/clerk/src/e.ts": 'import "@clerk/shared";\n',
    "docs/f.md": 'import { x } from "@clerk/react";\n',
  });
  assert.deepStrictEqual(findRemovedConnectProblems(repo.root, [], repo.files), [
    "apps/web/src/a.ts imports @clerk/; Clerk was removed with T3 Connect.",
    "apps/web/src/b.tsx imports @clerk/; Clerk was removed with T3 Connect.",
    "apps/desktop/src/c.cjs imports @clerk/; Clerk was removed with T3 Connect.",
    "apps/mobile/package.json depends on @clerk/expo; Clerk was removed with T3 Connect.",
  ]);
});

it("reports upstream analytics, crash reporting and hosted-app defaults in shipped code only", () => {
  using repo = fixture({
    "apps/server/src/a.ts": 'const key = "phc_fakeFixtureKey0123456789abcdef";\n',
    "apps/server/src/b.ts": 'const host = "https://ingest.t3.codes";\n',
    "packages/shared/src/c.ts": '\nexport const URL = "https://app.t3.codes";\n',
    "apps/server/src/d.ts":
      'fetch("https://raw.githubusercontent.com/pingdotgg/t3code/main/model-manifest.json");\n',
    "apps/mobile/modules/e/E.swift": 'let dsn = "https://key@o1.ingest.sentry.io/1"\n',
    "apps/web/package.json": JSON.stringify({ dependencies: { "posthog-js": "1" } }),
    "apps/mobile/package.json": JSON.stringify({ dependencies: { "expo-observe": "58" } }),
    "apps/server/src/f.test.ts": 'const host = "https://ingest.t3.codes";\n',
    "apps/marketing/src/g.astro": '<a href="https://posthog.com/privacy">PostHog</a>\n',
    "apps/web/vercel.ts": 'const ROUTER_HOST = "app.t3.codes";\n',
  });
  assert.deepStrictEqual(findRemovedConnectProblems(repo.root, [], repo.files), [
    "apps/server/src/a.ts:1 names a PostHog project key (phc_fakeFixtureKey0123456789abcdef). Shipped code must not reach it.",
    "apps/server/src/b.ts:1 names upstream's analytics endpoint (ingest.t3.codes). Shipped code must not reach it.",
    "packages/shared/src/c.ts:2 names upstream's hosted web app (app.t3.codes). Shipped code must not reach it.",
    "apps/server/src/d.ts:1 names content fetched from upstream (raw.githubusercontent.com/pingdotgg/). Shipped code must not reach it.",
    "apps/mobile/modules/e/E.swift:1 names a Sentry host (sentry.io). Shipped code must not reach it.",
    "apps/web/package.json depends on posthog-js; the fork sends no product analytics.",
    "apps/mobile/package.json depends on expo-observe; the fork sends no crash reports.",
  ]);
});

it("reads the checked-in manifest", () => {
  const paths = readManifestPaths(NodePath.resolve(import.meta.dirname, ".."));
  assert.include(paths, "infra/relay");
  assert.include(paths, "apps/server/src/relay");
  assert.include(paths, "apps/server/src/telemetry");
});
