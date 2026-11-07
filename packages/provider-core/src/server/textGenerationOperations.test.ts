import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { fromRunner, type Request } from "./textGenerationOperations.ts";
import { sanitizeDraftRewrite } from "./textGenerationUtils.ts";

describe("rewriteDraft", () => {
  it.effect("sends the draft as-is and trims the rewrite", () =>
    Effect.gen(function* () {
      const requests: Array<Request<never>> = [];
      const generation = fromRunner("Fake", (request) => {
        requests.push(request as Request<never>);
        return Effect.succeed({ text: "  Fix the login bug.\n" } as never);
      });
      const draft = "um so like fix the `login()` bug in src/auth.ts";

      const result = yield* generation.rewriteDraft({
        cwd: "/repo",
        text: draft,
        modelSelection: { instanceId: "claude", model: "haiku" } as never,
      });

      expect(result).toEqual({ text: "Fix the login bug." });
      expect(requests[0]?.operation).toBe("rewriteDraft");
      expect(requests[0]?.prompt.endsWith(`Draft:\n${draft}`)).toBe(true);
    }),
  );

  it.each([
    ['{"text": "Go to src/auth.ts."}', "Go to src/auth.ts."],
    ["{ not json } keep me", "{ not json } keep me"],
    ['{"other": 1}', '{"other": 1}'],
  ])("unwraps a nested JSON reply only when it holds text: %s", (raw, expected) => {
    expect(sanitizeDraftRewrite(raw)).toBe(expected);
  });
});
