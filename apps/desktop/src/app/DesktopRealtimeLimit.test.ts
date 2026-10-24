import { assert, describe, it } from "@effect/vitest";

import { parseRealtimeTimeoutHardLimit } from "./DesktopRealtimeLimit.ts";

const limits = (soft: string, hard: string) =>
  [
    "Limit                     Soft Limit           Hard Limit           Units     ",
    "Max realtime priority     0                    0                    ",
    `Max realtime timeout      ${soft.padEnd(20)} ${hard.padEnd(20)} us        `,
  ].join("\n");

describe("parseRealtimeTimeoutHardLimit", () => {
  it("reads the hard limit, so a 0 that kills on the first CPU timer is detected", () => {
    assert.strictEqual(parseRealtimeTimeoutHardLimit(limits("0", "0")), 0);
    assert.strictEqual(parseRealtimeTimeoutHardLimit(limits("200000", "200000")), 200000);
    assert.isNull(parseRealtimeTimeoutHardLimit(limits("unlimited", "unlimited")));
    assert.isUndefined(parseRealtimeTimeoutHardLimit("Max cpu time unlimited unlimited seconds"));
  });
});
