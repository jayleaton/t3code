import { describe, expect, it } from "vite-plus/test";

import { compactJson } from "./compactJson.ts";

describe("compactJson", () => {
  it("drops null, undefined and empty-array fields at any depth", () => {
    expect(
      compactJson({
        taskId: "task-1",
        needs: null,
        wake: undefined,
        evidence: [],
        task: { questionRequestId: null, sync: { lastError: null, state: "synced" } },
      }),
    ).toEqual({ taskId: "task-1", task: { sync: { state: "synced" } } });
  });

  it("keeps false, zero, empty strings and empty objects", () => {
    expect(
      compactJson({
        timedOut: false,
        cursor: 0,
        title: "",
        options: {},
        items: [{ hasMore: false }],
      }),
    ).toEqual({ timedOut: false, cursor: 0, title: "", options: {}, items: [{ hasMore: false }] });
  });

  it("keeps array elements in place", () => {
    expect(compactJson({ results: [null, { error: null, ok: true }, []] })).toEqual({
      results: [null, { ok: true }, []],
    });
  });
});
