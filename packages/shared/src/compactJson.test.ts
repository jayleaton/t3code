import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { compactJson, expandCompactJson } from "./compactJson.ts";

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

describe("expandCompactJson", () => {
  const Item = Schema.Union([
    Schema.Struct({ type: Schema.Literal("message"), text: Schema.NullOr(Schema.String) }),
    Schema.Struct({ type: Schema.Literal("files"), files: Schema.Array(Schema.String) }),
  ]);
  const Result = Schema.Struct({
    runId: Schema.NullOr(Schema.String),
    timedOut: Schema.Boolean,
    items: Schema.Array(Item),
    note: Schema.optional(Schema.NullOr(Schema.String)),
  });
  const decode = Schema.decodeUnknownSync(Result);

  it("decodes what compactJson left out back to null and empty arrays", () => {
    const full = {
      runId: null,
      timedOut: false,
      items: [
        { type: "message", text: null },
        { type: "files", files: [] },
      ],
    };
    expect(decode(expandCompactJson(Result, compactJson(full)))).toEqual(full);
  });

  it("leaves optional keys absent", () => {
    expect(expandCompactJson(Result, { timedOut: true })).toEqual({
      runId: null,
      timedOut: true,
      items: [],
    });
  });
});
