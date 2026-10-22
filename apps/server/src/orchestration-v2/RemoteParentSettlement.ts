import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { McpGatewayBroker } from "../mcp/McpGatewayBroker.ts";

/**
 * Whether a parent on another environment was settled by hand, read through a connected T3
 * app. A sub-run that was still working when that card settled follows it from this.
 */
export class RemoteParentSettlement extends Context.Service<
  RemoteParentSettlement,
  {
    /**
     * The manual settle time of the thread, or of its nearest manually settled ancestor past
     * ones that only aged out. Null when none is, or when it cannot be told: no app reaches
     * the environment, or the environment or app predates reporting how a thread settled.
     */
    readonly manualSettledAt: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<DateTime.Utc | null>;
  }
>()("t3/orchestration-v2/RemoteParentSettlement") {}

const RemoteThread = Schema.Struct({
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  settledAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  settlementSource: Schema.optional(Schema.NullOr(Schema.Literals(["manual", "inactivity"]))),
});
const decodeRemoteThread = Schema.decodeUnknownEffect(RemoteThread);

// Parent links are acyclic; this only bounds a corrupt or adversarial chain.
const MAX_HOPS = 16;

export const layerFromBroker = Layer.effect(
  RemoteParentSettlement,
  Effect.gen(function* () {
    const broker = yield* McpGatewayBroker;
    const read = (environmentId: EnvironmentId, threadId: ThreadId) =>
      broker.grants()[environmentId]?.includes("read") === true
        ? broker
            .invoke("getThread", [environmentId, threadId], [environmentId])
            .pipe(Effect.flatMap(decodeRemoteThread), Effect.option)
        : Effect.succeedNone;
    return RemoteParentSettlement.of({
      manualSettledAt: Effect.fn("RemoteParentSettlement.manualSettledAt")(
        function* (environmentId, threadId) {
          let environment = environmentId;
          let current = threadId;
          for (let hop = 0; hop < MAX_HOPS; hop++) {
            const found = yield* read(environment, current);
            if (found._tag === "None" || found.value.settledAt == null) return null;
            const thread = found.value;
            if (thread.settlementSource === "manual") return thread.settledAt ?? null;
            if (thread.settlementSource !== "inactivity" || thread.parentThreadId == null) {
              return null;
            }
            environment = thread.parentEnvironmentId ?? environment;
            current = thread.parentThreadId;
          }
          return null;
        },
      ),
    });
  }),
);
