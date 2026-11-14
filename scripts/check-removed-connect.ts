#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small sync check with no Effect runtime.
// Fails when an upstream sync brings back T3 Connect, upstream analytics or crash reporting, or a
// default that points the shipped product at a host upstream controls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST_PATH = "scripts/removed-connect-paths.json";
const SELF_PATHS = new Set([
  MANIFEST_PATH,
  "scripts/check-removed-connect.ts",
  "scripts/check-removed-connect.test.ts",
]);
const SOURCE = /\.(?:[cm]?[jt]sx?|astro|swift|kt)$/;
const TEST = /\.test\.[cm]?[jt]sx?$|\/test\/|\/fixtures?\//;
const SHIPPED_ROOTS = ["apps/server/", "apps/web/", "apps/desktop/", "apps/mobile/", "packages/"];
// Upstream's own hosted deploy config; the fork never deploys it.
const NOT_SHIPPED = new Set(["apps/web/vercel.ts"]);
const CLERK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@clerk\//;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const BANNED_DEPENDENCIES: ReadonlyArray<{ readonly prefix: string; readonly why: string }> = [
  { prefix: "@clerk/", why: "Clerk was removed with T3 Connect" },
  { prefix: "posthog-", why: "the fork sends no product analytics" },
  { prefix: "@posthog/", why: "the fork sends no product analytics" },
  { prefix: "@sentry/", why: "the fork sends no crash reports" },
  { prefix: "expo-observe", why: "the fork sends no crash reports" },
];

/** Hosts and keys that reach upstream from shipped code. Comments count: they become code. */
export const BANNED_CONTENT: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  { pattern: /\bphc_[A-Za-z0-9]{20,}/, why: "a PostHog project key" },
  { pattern: /T3CODE_POSTHOG_/, why: "upstream's PostHog settings" },
  { pattern: /posthog\.com/, why: "a PostHog host" },
  { pattern: /ingest\.t3\.codes/, why: "upstream's analytics endpoint" },
  { pattern: /sentry\.io/, why: "a Sentry host" },
  { pattern: /app\.t3\.codes/, why: "upstream's hosted web app" },
  { pattern: /raw\.githubusercontent\.com\/pingdotgg\//, why: "content fetched from upstream" },
  { pattern: /github\.com\/pingdotgg\/t3code\/releases/, why: "upstream's release downloads" },
];

export function readManifestPaths(root: string): ReadonlyArray<string> {
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, MANIFEST_PATH), "utf8"),
  );
  const paths =
    typeof manifest === "object" && manifest !== null && "paths" in manifest
      ? manifest.paths
      : undefined;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw new Error(`${MANIFEST_PATH} must hold a "paths" array of strings.`);
  }
  return paths;
}

function bannedDependencies(packageJson: string): ReadonlyArray<string> {
  const parsed: unknown = JSON.parse(packageJson);
  if (typeof parsed !== "object" || parsed === null) return [];
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies: unknown = Reflect.get(parsed, field);
    if (typeof dependencies !== "object" || dependencies === null) return [];
    return Object.keys(dependencies).flatMap((name) => {
      const banned = BANNED_DEPENDENCIES.find((entry) => name.startsWith(entry.prefix));
      return banned === undefined ? [] : [`depends on ${name}; ${banned.why}.`];
    });
  });
}

function isShippedSource(file: string): boolean {
  return (
    SHIPPED_ROOTS.some((root) => file.startsWith(root)) &&
    SOURCE.test(file) &&
    !TEST.test(file) &&
    !NOT_SHIPPED.has(file)
  );
}

/** Problems in `root`, given its manifest paths and the repository files to scan. */
export function findRemovedConnectProblems(
  root: string,
  removedPaths: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const problems = removedPaths
    .filter((path) => NodeFS.existsSync(NodePath.join(root, path)))
    .map((path) => `${path} was removed from the fork and is back. Delete it.`);
  for (const file of files) {
    if (SELF_PATHS.has(file) || file.startsWith(".repos/") || file.includes("node_modules/")) {
      continue;
    }
    const isManifest = NodePath.basename(file) === "package.json";
    if (!isManifest && !SOURCE.test(file)) continue;
    const absolute = NodePath.join(root, file);
    if (!NodeFS.existsSync(absolute)) continue;
    const text = NodeFS.readFileSync(absolute, "utf8");
    if (isManifest) {
      for (const problem of bannedDependencies(text)) problems.push(`${file} ${problem}`);
      continue;
    }
    if (CLERK_IMPORT.test(text)) {
      problems.push(`${file} imports @clerk/; Clerk was removed with T3 Connect.`);
    }
    if (!isShippedSource(file)) continue;
    for (const { pattern, why } of BANNED_CONTENT) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${file}:${line} names ${why} (${match[0]}). Shipped code must not reach it.`);
    }
  }
  return problems;
}

function main() {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const files = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const problems = findRemovedConnectProblems(root, readManifestPaths(root), files);
  if (problems.length === 0) {
    console.log(
      "check-removed-connect: no T3 Connect, upstream analytics or upstream hosts found.",
    );
    return;
  }
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
}

if (import.meta.main) main();
