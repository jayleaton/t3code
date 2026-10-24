import type { EnvironmentId, OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

export type ManualSettlementAbove =
  | { readonly settledAt: DateTime.Utc }
  | { readonly remote: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } }
  | null;

/**
 * What a sub-run's settle follows: the settle time of its nearest manually
 * settled ancestor here, or the ancestor on another machine the walk
 * reaches, which only that machine can answer for. Ancestors that only
 * aged out are looked past, since age settlement never cascades and must
 * not cut a manual cascade short.
 */
export const manualSettlementAbove = Effect.fn("orchestrationV2.dispatch.manualSettlementAbove")(
  function* (
    projections: Pick<ProjectionStoreV2Shape, "getThread">,
    thread: OrchestrationV2AppThread,
  ): Effect.fn.Return<ManualSettlementAbove> {
    const seen = new Set<ThreadId>([thread.id]);
    let current = thread;
    while (current.parentThreadId != null) {
      if (current.parentEnvironmentId != null) {
        return {
          remote: { environmentId: current.parentEnvironmentId, threadId: current.parentThreadId },
        };
      }
      if (seen.has(current.parentThreadId)) return null;
      seen.add(current.parentThreadId);
      const parent = yield* projections
        .getThread(current.parentThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (parent === null || parent.deletedAt !== null || parent.settledOverride !== "settled") {
        return null;
      }
      if (parent.settlementSource !== "inactivity") {
        return parent.settledAt === null ? null : { settledAt: parent.settledAt };
      }
      current = parent;
    }
    return null;
  },
);
