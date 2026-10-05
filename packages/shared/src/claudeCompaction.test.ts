import { describe, expect, it } from "vite-plus/test";

import { formatClaudeResumeCompactionQuestion } from "./claudeCompaction.ts";

describe("claude resume compaction copy", () => {
  it("formats ages above and below one hour", () => {
    expect(
      formatClaudeResumeCompactionQuestion({ ageMinutes: 145, estimatedTokens: 275_123 }),
    ).toBe("This session is 2h 25m old and uses 275,123 tokens. Compact it before continuing?");
    expect(formatClaudeResumeCompactionQuestion({ ageMinutes: 45, estimatedTokens: 1_000 })).toBe(
      "This session is 45m old and uses 1,000 tokens. Compact it before continuing?",
    );
  });
});
