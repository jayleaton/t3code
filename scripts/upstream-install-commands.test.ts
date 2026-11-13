// @effect-diagnostics nodeBuiltinImport:off - Scans the checked-in tree with git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const ROOT = NodePath.resolve(import.meta.dirname, "..");

function trackedFiles(scanned: ReadonlyArray<string>, excluded: ReadonlyArray<RegExp>): string[] {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...scanned], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && !excluded.some((pattern) => pattern.test(file)))
    .filter((file) => NodeFS.existsSync(NodePath.join(ROOT, file)));
}

function readLines(file: string): string[] {
  return NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8").split("\n");
}

// Each of these installs upstream's server, which replaces the fork's on that machine.
const UPSTREAM_INSTALL =
  /t3\.codes\/install\.(?:sh|ps1)|\b(?:npx(?: --yes| -y)?|pnpm dlx|bunx) t3(?![\w-])/;

it("keeps upstream install commands out of user-facing fork code and docs", () => {
  const files = trackedFiles(
    ["apps", "packages", "scripts", "packaging", "docs/user"],
    [
      /\.test\.tsx?$/,
      // Model-facing text, changed only with its evals (evals/README.md).
      /^apps\/server\/src\/triage\/triagePrompt\.ts$/,
    ],
  );
  const hits = files.flatMap((file) =>
    readLines(file).flatMap((line, index) =>
      UPSTREAM_INSTALL.test(line) ? [`${file}:${index + 1}`] : [],
    ),
  );
  expect(hits).toEqual([]);
});

// The fork ships as Ada (packages/shared/src/branding.ts). Upstream syncs bring these back.
const UPSTREAM_BRAND = /T3 Code|T3 Agents|\bTheo\b|t3\.codes|pingdotgg/;

const BRAND_SCANNED = [
  "README.md",
  "docs/user",
  "apps/web/src",
  "apps/web/index.html",
  "apps/web/public/manifest.webmanifest",
  "apps/desktop/src",
  "apps/desktop/resources",
  "apps/desktop/gnome-extension",
  "apps/desktop/scripts/electron-launcher.mjs",
  "apps/desktop/package.json",
  "apps/mobile/src",
  "apps/mobile/app.config.ts",
  "apps/marketing/src",
  "apps/server/src",
  "packages",
  "scripts/build-desktop-artifact.ts",
  "scripts/install.sh",
  "scripts/install.ps1",
];

const BRAND_EXCLUDED = [
  /\.test\.tsx?$/,
  /\/test\//,
  /\/testkit\//,
  /\/fixtures?\//,
  /\.fixture\.ts$/,
];

/**
 * What may keep an upstream name, and why. Everything else a user can see says Ada.
 * `text` narrows an entry to lines containing it; without it the whole file is allowed.
 */
const BRAND_ALLOWLIST: ReadonlyArray<{ file: RegExp; text?: string; why: string }> = [
  {
    file: /^packages\/shared\/src\/branding\.ts$/,
    why: "Names the upstream app the fork installs beside, so copy about it can say so.",
  },
];

/** Comment lines are for maintainers, not users. Markdown has no comments worth skipping. */
function isCommentLine(file: string, line: string): boolean {
  if (/\.mdx?$/.test(file)) return false;
  const code = line.trim();
  return (
    code.startsWith("//") ||
    code.startsWith("*") ||
    code.startsWith("/*") ||
    code.startsWith("<!--") ||
    (/\.(?:sh|ps1|nsh|ya?ml|py)$|(?:^|\/)[^.]+$/.test(file) && code.startsWith("#"))
  );
}

it("keeps upstream brand names out of user-facing fork code and docs", () => {
  const hits = trackedFiles(BRAND_SCANNED, BRAND_EXCLUDED).flatMap((file) =>
    readLines(file).flatMap((line, index) => {
      if (isCommentLine(file, line)) return [];
      const visible = line.replace(/\s\/\/\s.*$/, "");
      if (!UPSTREAM_BRAND.test(visible)) return [];
      const allowed = BRAND_ALLOWLIST.some(
        (entry) =>
          entry.file.test(file) && (entry.text === undefined || visible.includes(entry.text)),
      );
      return allowed ? [] : [`${file}:${index + 1}`];
    }),
  );
  expect(hits).toEqual([]);
});
