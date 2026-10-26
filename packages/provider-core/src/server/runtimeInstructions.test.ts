import { assert, describe, it } from "@effect/vitest";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Muse Code",
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    assert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    assert.notMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});
