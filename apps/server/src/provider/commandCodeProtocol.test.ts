import { describe, expect, it } from "@effect/vitest";
import {
  commandCodePermissionArgs,
  decodeCommandCodeFrame,
  parseCommandCodeModels,
} from "./commandCodeProtocol.ts";

describe("Command Code protocol", () => {
  it("never bypasses approval-required or auto permissions", () => {
    expect(commandCodePermissionArgs("approval-required", false)).toEqual([
      "--permission-mode",
      "dont-ask",
    ]);
    expect(commandCodePermissionArgs("auto", false)).toEqual(["--permission-mode", "dont-ask"]);
    expect(commandCodePermissionArgs("auto-accept-edits", false)).toEqual([
      "--permission-mode",
      "auto-accept",
    ]);
    expect(commandCodePermissionArgs("full-access", false)).toEqual(["--yolo"]);
    expect(commandCodePermissionArgs("full-access", true)).toEqual(["--plan"]);
  });
  it("accepts early errors with no session id and unknown future events", () => {
    expect(
      decodeCommandCodeFrame(
        '{"type":"result","subtype":"error","finalText":"","error":"Not authenticated"}',
      ),
    ).toMatchObject({ subtype: "error" });
    expect(
      decodeCommandCodeFrame('{"type":"event","event":{"type":"future_event"}}'),
    ).toMatchObject({ type: "event" });
    expect(() => decodeCommandCodeFrame("not json")).toThrow();
  });
  it("parses CLI model rows without treating headers and examples as models", () => {
    const output =
      "Available models  ·  2 models\n\nOpenAI\n\ngpt-6-astra  General coding\nmoonshotai/kimi-k2.5  Coding (default)\ngpt-6-astra  Duplicate\n\ncmd --model kimi-k2.5\nDocs:  https://commandcode.ai/docs";
    expect(parseCommandCodeModels(output).map((model) => model.slug)).toEqual([
      "default",
      "gpt-6-astra",
      "moonshotai/kimi-k2.5",
    ]);
  });
});

it("uses inclusive input usage without double-counting cache reads", async () => {
  const { commandCodeTokenUsage, commandCodeToolData } = await import("./commandCodeProtocol.ts");
  expect(
    commandCodeTokenUsage(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5 },
      false,
    ),
  ).toMatchObject({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 80,
    cacheCreationTokens: 5,
    usageStatus: "complete",
  });
  expect(commandCodeTokenUsage({ inputTokens: -1, outputTokens: 3 }, false).usageStatus).toBe(
    "unavailable",
  );
  expect(String(commandCodeToolData({ text: "x".repeat(100_000) })).length).toBeLessThan(17_000);
});
