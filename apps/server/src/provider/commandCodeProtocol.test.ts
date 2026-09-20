import { describe, expect, it } from "@effect/vitest";
import {
  commandCodePermissionArgs,
  createCommandCodeThroughputTracker,
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

describe("Command Code request throughput", () => {
  it("pairs real request usage with its duration and excludes the tool loop between requests", () => {
    const track = createCommandCodeThroughputTracker();
    expect(track({ type: "model_request_start", model: "model" }, 1000)).toBeUndefined();
    expect(
      track(
        {
          type: "model_request_end",
          model: "model",
          usage: { inputTokens: 1000, outputTokens: 200 },
        },
        3000,
      ),
    ).toEqual({ outputTokens: 200, durationMs: 2000, scope: "response", timingSource: "observed" });
    track({ type: "tool_running" }, 4000);
    track({ type: "model_request_start", model: "model" }, 14000);
    expect(
      track(
        {
          type: "model_request_end",
          model: "model",
          usage: { inputTokens: 2000, outputTokens: 300 },
        },
        15000,
      )?.durationMs,
    ).toBe(1000);
  });
  it("does not fabricate rates for missing boundaries, invalid usage, mismatched models, or duplicate ends", () => {
    const track = createCommandCodeThroughputTracker();
    const end = {
      type: "model_request_end",
      model: "model",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    expect(track(end, 1000)).toBeUndefined();
    track({ type: "model_request_start", model: "other" }, 1000);
    expect(track(end, 2000)).toBeUndefined();
    track({ type: "model_request_start", model: "model" }, 2000);
    expect(track({ ...end, usage: { outputTokens: -1 } }, 3000)).toBeUndefined();
    track({ type: "model_request_start", model: "model" }, 3000);
    expect(track(end, 3000)).toBeUndefined();
    track({ type: "model_request_start", model: "model" }, 4000);
    expect(track(end, 5000)?.outputTokens).toBe(20);
    expect(track(end, 6000)).toBeUndefined();
  });
});
