// @effect-diagnostics nodeBuiltinImport:off - Scans the checked-in tree with git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// Each of these installs upstream's server, which replaces the fork's on that machine.
const UPSTREAM_INSTALL =
  /t3\.codes\/install\.(?:sh|ps1)|\b(?:npx(?: --yes| -y)?|pnpm dlx|bunx) t3(?![\w-])/;
const SCANNED = ["apps", "packages", "scripts", "packaging", "docs/user"];
const EXCLUDED = [
  /\.test\.tsx?$/,
  // Upstream's marketing site; the fork does not deploy it.
  /^apps\/marketing\//,
  // Model-facing text, changed only with its evals (evals/README.md).
  /^apps\/server\/src\/triage\/triagePrompt\.ts$/,
];

it("keeps upstream install commands out of user-facing fork code and docs", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const files = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", ...SCANNED], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && !EXCLUDED.some((pattern) => pattern.test(file)));
  const hits = files.flatMap((file) => {
    const path = NodePath.join(root, file);
    if (!NodeFS.existsSync(path)) return [];
    return NodeFS.readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) => (UPSTREAM_INSTALL.test(line) ? [`${file}:${index + 1}`] : []));
  });
  expect(hits).toEqual([]);
});
