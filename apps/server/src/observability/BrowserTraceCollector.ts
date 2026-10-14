import type { TraceRecord, TraceSampling, TraceSink } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("t3/observability/BrowserTraceCollector") {}

/**
 * Browser spans arrive finished and in batches, so the local file samples them
 * by trace: every routine span of a trace is kept or dropped together. Roots,
 * failures, slow spans, and lifecycle names are always kept.
 */
export const keepBrowserRecord = (record: TraceRecord, sampling: TraceSampling): boolean =>
  sampling.rate >= 1 ||
  record.parentSpanId === undefined ||
  record.durationMs >= sampling.slowSpanMs ||
  // OTLP status code 2 is ERROR.
  (record.type === "otlp-span" ? record.status?.code === "2" : record.exit._tag !== "Success") ||
  sampling.keepName?.(record.name) === true ||
  Number.parseInt(record.traceId.slice(-8), 16) / 2 ** 32 < sampling.rate;

/** @public Service construction is part of the canonical Effect module API. */
export const make = (sink: TraceSink, sampling: TraceSampling): BrowserTraceCollector["Service"] =>
  BrowserTraceCollector.of({
    record: (records) =>
      Effect.sync(() => {
        for (const record of records) {
          if (keepBrowserRecord(record, sampling)) sink.push(record);
        }
      }),
  });

export const layer = (sink: TraceSink, sampling: TraceSampling) =>
  Layer.succeed(BrowserTraceCollector, make(sink, sampling));
