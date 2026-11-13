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
  /\.test\.[cm]?[jt]sx?$/,
  /\.testkit\.ts$/,
  /\/test\//,
  /\/testkit\//,
  /\/fixtures?\//,
  /\.fixture\.ts$/,
];

type BrandAllowance = { file: RegExp; text?: string; why: string };

/**
 * What may keep an upstream name, and why. Everything else a user can see says Ada.
 * With `text`, only that substring is allowed: the rest of the line is still checked.
 */
const BRAND_ALLOWLIST: ReadonlyArray<BrandAllowance> = [
  {
    file: /^packages\/shared\/src\/branding\.ts$/,
    why: "Names the upstream app the fork installs beside, so copy about it can say so.",
  },
  // Functional endpoints the fork still uses. Renaming them would break the feature, not rebrand it.
  { file: /./, text: "app.t3.codes", why: "Hosted web client and its thread links." },
  { file: /./, text: "ingest.t3.codes", why: "Telemetry endpoint the server reports to." },
  { file: /./, text: "t3.codes/schema/t3.json", why: "Published t3.json schema URL." },
  {
    file: /^apps\/server\/src\/provider\/ModelManifest\.ts$/,
    text: "raw.githubusercontent.com/pingdotgg/t3code",
    why: "Model manifest the server downloads.",
  },
  // Legal: the privacy policy and terms cover the upstream telemetry the fork still sends.
  {
    file: /^apps\/marketing\/src\/pages\/(?:privacy-policy|terms-of-service|security-policy|legal)\.astro$/,
    why: "Legal text is not ours to rewrite.",
  },
  {
    file: /^apps\/marketing\/src\/pages\/\.well-known\/security\.txt\.ts$/,
    why: "Security contact belongs with the security policy.",
  },
  { file: /^apps\/web\/src\/legalLinks\.ts$/, why: "Privacy policy link." },
  {
    file: /^apps\/mobile\/src\/features\/settings\/lib\/legal-document-url\.ts$/,
    why: "Legal documents host.",
  },
  // Model-facing text changes only with its evals (evals/README.md); users never read it directly.
  { file: /^apps\/server\/src\/triage\//, why: "Triage agent prompt and its issue target." },
  // Identities other systems already know: providers, git history, peers, installed helpers.
  {
    file: /^(?:apps\/server\/src\/(?:provider\/(?:CodexProvider|CodexChatGptAuth|acp\/AntigravityAcpSupport)|mcp\/McpHttpServer)|packages\/provider-muse\/src\/server\/sdk)\.ts$/,
    text: "T3 Code",
    why: "Client name sent to providers.",
  },
  {
    file: /^(?:apps\/server\/src\/vcs\/GitVcsDriver|packages\/source-control-github\/src\/server\/githubStackRebase|packages\/provider-testing\/src\/replayWorkspace)\.ts$/,
    why: "Git author identity on commits the app makes.",
  },
  {
    file: /^apps\/server\/src\/peer\//,
    text: "T3 Code · ",
    why: "Peer session label prefix that other environments, upstream included, strip.",
  },
  {
    file: /^packages\/provider-opencode\/src\/server\/(?:OpenCodeServerLedger|v2\/adapter)\.ts$/,
    why: "Maintainer log lines.",
  },
  {
    file: /^apps\/server\/src\/mcp\/agents\/HeadlessGatewayHost\.ts$/,
    text: "Headless T3 Agents gateway",
    why: "Maintainer log lines.",
  },
  {
    file: /^apps\/desktop\/gnome-extension\/(?:metadata|bundle)\.json$/,
    text: "snap-shot@t3.codes",
    why: "UUID of the installed GNOME extension.",
  },
  {
    file: /^scripts\/build-desktop-artifact\.ts$/,
    text: "hello@t3.codes",
    why: "Deb maintainer email.",
  },
  // Legacy names that find or migrate existing installs, so updates land in place.
  {
    file: /^apps\/desktop\/src\/app\/(?:DesktopUserData|DesktopLegacyLocalStorage|WindowsSharedProfile)\.ts$/,
    why: "Legacy profile directories and the pre-rename profile owner.",
  },
  {
    file: /^apps\/desktop\/resources\/installer\.nsh$/,
    why: "Legacy exe names of a running app.",
  },
  {
    file: /^scripts\/build-desktop-artifact\.ts$/,
    text: '"T3 Agents"',
    why: "Pinned Windows exe name: taskbar pins, CLI shims and service units point at it.",
  },
  // Copy about the separate upstream product, which the fork installs beside.
  {
    file: /^apps\/desktop\/resources\/agents-installer\.nsh$/,
    text: "T3 Code",
    why: "Installer guards that protect T3 Code's folder.",
  },
  {
    file: /^packages\/source-control-github\/src\/shared\/definition\.ts$/,
    text: "T3 Code for GitHub",
    why: "Upstream's GitHub App name.",
  },
  {
    file: /^README\.md$/,
    text: "T3 Code",
    why: "Switching from T3 Code, which installs beside Ada.",
  },
  {
    file: /^docs\/user\/(?:install|updating)\.md$/,
    text: "T3 Code",
    why: "Warnings that T3 Code's installers replace Ada's server.",
  },
  {
    file: /^apps\/marketing\/src\/(?:lib\/seo\.ts|pages\/95\.astro)$/,
    text: "https://t3.codes",
    why: "Site origin, until the fork has its own domain.",
  },
  // Renamed by the CLI alias change stacked on this one, which removes this entry.
  {
    file: /^(?:apps\/server\/src\/(?:cli\/|service\/|serviceLauncher\.ts)|apps\/desktop\/src\/app\/DesktopCli(?:Command|Shim)\.ts|scripts\/install\.(?:sh|ps1)$)/,
    why: "CLI copy, renamed with the ada command.",
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
      let visible = line.replace(/\s\/\/\s.*$/, "");
      for (const entry of BRAND_ALLOWLIST) {
        if (!entry.file.test(file)) continue;
        if (entry.text === undefined) return [];
        visible = visible.replaceAll(entry.text, "");
      }
      return UPSTREAM_BRAND.test(visible) ? [`${file}:${index + 1}`] : [];
    }),
  );
  expect(hits).toEqual([]);
});
