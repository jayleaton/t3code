import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { APP_NAME } from "@t3tools/shared/branding";
import { describe, expect, it } from "vite-plus/test";

import { MOBILE_APP_NAME, resolveMobileStageLabel } from "./mobileBranding";

const MOBILE_ROOT = NodePath.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

const UPSTREAM_NAMES = ["T3 Code", "T3 Agents"];

/** Lines that still say an upstream name outside a comment. */
function upstreamBrandLines(file: string): string[] {
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return [];
      const beforeComment = line.replace(/\s\/\/.*$/, "");
      return UPSTREAM_NAMES.some((name) => beforeComment.includes(name))
        ? [`${NodePath.relative(MOBILE_ROOT, file)}:${index + 1}`]
        : [];
    });
}

describe("mobile branding", () => {
  it("names the fork's app Ada", () => {
    expect(MOBILE_APP_NAME).toBe(APP_NAME);
    expect(APP_NAME).toBe("Ada");
  });

  it("shows no stage badge on release builds", () => {
    expect(resolveMobileStageLabel("production")).toBeNull();
    expect(resolveMobileStageLabel(undefined)).toBeNull();
    expect(resolveMobileStageLabel("development")).toBe("Dev");
    expect(resolveMobileStageLabel("preview")).toBe("Nightly");
  });

  // Upstream syncs bring "T3 Code" copy back, and the fork used to ship as "T3 Agents"; user-visible names go through MOBILE_APP_NAME.
  it("shows no upstream name in the app", () => {
    const files = [
      ...sourceFiles(NodePath.join(MOBILE_ROOT, "src")),
      NodePath.join(MOBILE_ROOT, "app.config.ts"),
    ];
    expect(files.flatMap(upstreamBrandLines)).toEqual([]);
  });
});
