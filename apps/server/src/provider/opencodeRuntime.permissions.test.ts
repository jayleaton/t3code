import * as NodeAssert from "node:assert/strict";

import * as RegExpUtils from "effect/RegExp";
import { describe, it } from "vite-plus/test";

import { buildOpenCodePermissionRules, toOpenCodePermissionReply } from "./opencodeRuntime.ts";

function actionFor(
  runtimeMode: Parameters<typeof buildOpenCodePermissionRules>[0],
  permission: string,
  target = "*",
) {
  // OpenCode uses the last matching rule. Its wildcards match directory separators.
  return buildOpenCodePermissionRules(runtimeMode).findLast(
    (rule) =>
      (rule.permission === "*" || rule.permission === permission) &&
      new RegExp(`^${RegExpUtils.escape(rule.pattern).replaceAll("\\*", ".*")}$`, "s").test(target),
  )?.action;
}

describe("buildOpenCodePermissionRules", () => {
  it("pre-approves edits once the user has chosen to auto-accept them", () => {
    NodeAssert.equal(actionFor("auto-accept-edits", "edit"), "allow");
  });

  it("still asks before editing when approval is required", () => {
    NodeAssert.equal(actionFor("approval-required", "edit"), "ask");
  });

  // Documented in docs/user/permission-modes.md: providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for "auto".
  it("leaves auto asking, as the docs say it does without a reviewer", () => {
    NodeAssert.equal(actionFor("auto", "edit"), "ask");
  });

  it("allows workspace reads and task updates without asking in supervised modes", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const permission of ["read", "glob", "grep", "lsp", "skill", "todowrite"]) {
        NodeAssert.equal(actionFor(runtimeMode, permission, "src/index.ts"), "allow");
      }
    }
  });

  it("preserves OpenCode's environment-file approval rules", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const target of [
        ".env",
        ".env.local",
        "config/service.env",
        "config/service.env.local",
      ]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "ask");
      }
      for (const target of [".env.example", "config/service.env.example"]) {
        NodeAssert.equal(actionFor(runtimeMode, "read", target), "allow");
      }
    }
  });

  it("still asks before commands, network access, external directories and unknown tools", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "bash"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "webfetch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "websearch"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "external_directory"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "doom_loop"), "ask");
      NodeAssert.equal(actionFor(runtimeMode, "custom_tool"), "ask");
    }
  });

  it("allows everything under full access but denies the doom loop guard", () => {
    NodeAssert.deepEqual(buildOpenCodePermissionRules("full-access"), [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
      // `ask` is auto-approved in full-access, so the guard must deny instead.
      { permission: "doom_loop", pattern: "*", action: "deny" },
    ]);
    NodeAssert.equal(actionFor("full-access", "external_directory"), "allow");
    NodeAssert.equal(actionFor("full-access", "bash"), "allow");
    // `deny` is terminal and only trips OpenCode's repeated-identical-call
    // heuristic, so an unattended first call still runs.
    NodeAssert.equal(actionFor("full-access", "doom_loop"), "deny");
  });

  it("still asks before the doom loop guard outside full access", () => {
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      NodeAssert.equal(actionFor(runtimeMode, "doom_loop"), "ask");
    }
  });
});

describe("toOpenCodePermissionReply", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["acceptAlways", "always"],
    ["decline", "reject"],
    ["cancel", "reject"],
  ] as const)("maps %s to %s", (decision, reply) => {
    NodeAssert.equal(toOpenCodePermissionReply(decision), reply);
  });
});
