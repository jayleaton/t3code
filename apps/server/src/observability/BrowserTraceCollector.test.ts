import type { OtlpTraceRecord } from "@t3tools/shared/observability";
import { assert, describe, it } from "@effect/vitest";

import { keepBrowserRecord } from "./BrowserTraceCollector.ts";

const record = (overrides: Partial<OtlpTraceRecord>, root = false): OtlpTraceRecord => ({
  type: "otlp-span",
  name: "EnvironmentThreadState.applyItems",
  kind: "internal",
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  ...(root ? {} : { parentSpanId: "fedcba9876543210" }),
  sampled: true,
  startTimeUnixNano: "0",
  endTimeUnixNano: "1000000",
  durationMs: 1,
  attributes: {},
  events: [],
  links: [],
  resourceAttributes: {},
  scope: { attributes: {} },
  status: { code: "1" },
  ...overrides,
});

describe("keepBrowserRecord", () => {
  const sampling = { rate: 0.05, slowSpanMs: 1_000 };
  const sampledInTrace = "ffffffffffffffffffffffff00000000";
  const sampledOutTrace = "00000000000000000000000ffffffff";

  it("samples routine spans by trace and always keeps roots, failures, and slow spans", () => {
    assert.isTrue(keepBrowserRecord(record({ traceId: sampledInTrace }), sampling));
    assert.isFalse(keepBrowserRecord(record({ traceId: sampledOutTrace }), sampling));
    assert.isTrue(keepBrowserRecord(record({ traceId: sampledOutTrace }, true), sampling));
    assert.isTrue(
      keepBrowserRecord(record({ traceId: sampledOutTrace, status: { code: "2" } }), sampling),
    );
    assert.isTrue(
      keepBrowserRecord(record({ traceId: sampledOutTrace, durationMs: 1_000 }), sampling),
    );
    assert.isTrue(
      keepBrowserRecord(record({ traceId: sampledOutTrace }), { ...sampling, rate: 1 }),
    );
  });
});
