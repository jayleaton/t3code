import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  it.each([undefined, { browser: true, device: true }])(
    "keeps every entry within Codex's per-entry cap with tools %j",
    (availability) => {
      const context = buildCodexAdditionalContext(availability);

      for (const [key, entry] of Object.entries(context)) {
        // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
        const bytes = Buffer.byteLength(entry.value, "utf8");
        const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
        NodeAssert.ok(
          bytes <= limit,
          `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
        );
      }
    },
  );
});

describe("Codex orchestration context", () => {
  it("routes same-child follow-ups to t3_thread_send and independent reviews to delegate_task", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext())
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(
      orchestration.includes(
        "For independent T3 delegated review rounds, call `delegate_task` again.",
      ),
    );
    NodeAssert.ok(
      orchestration.includes(
        "For a follow-up that needs the same child's conversation, use `t3_thread_send` on its `childThreadId`.",
      ),
    );
    NodeAssert.ok(!orchestration.includes("Do not use `t3_thread_send`"));
  });
});
