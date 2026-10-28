import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { ProjectionStoreV2, type ProjectionStoreV2Error } from "./ProjectionStore.ts";

export type SettlementCascadeRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: "thread-settlement.cascade" }
>;

/** Manual settlement follows the sub-run tree; unsettle restores only matching settledBy rows.
 * The resumable outbox walk starts after commit; each child uses thread.settlement.follow
 * so working children defer until completion. Age-based settlement never cascades. */
export class SettlementCascade extends Context.Service<
  SettlementCascade,
  {
    readonly run: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly request: SettlementCascadeRequest;
    }) => Effect.Effect<void, ProjectionStoreV2Error>;
  }
>()("t3/orchestration-v2/SettlementCascade") {}

export const layer = Layer.effect(
  SettlementCascade,
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionStoreV2;

    const run = Effect.fn("SettlementCascade.run")(function* (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly request: SettlementCascadeRequest;
    }) {
      const { action, settledBy, settledAt } = input.request;
      const settledAtMs = DateTime.toEpochMillis(settledAt);
      const visited = new Set<ThreadId>([input.threadId]);
      // Depth first, child chats before subagents: chats are the cards the user sees, and a
      // Captain's listener subagents can far outnumber them.
      const walk: (parentThreadId: ThreadId) => Effect.Effect<void, ProjectionStoreV2Error> =
        Effect.fn("SettlementCascade.walk")(function* (parentThreadId: ThreadId) {
          const children = yield* projections.getChildThreads(parentThreadId);
          for (const child of children.toSorted(
            (left, right) =>
              Number(left.parentRelationship === "subagent") -
              Number(right.parentRelationship === "subagent"),
          )) {
            // Children on other environments follow through RemoteSettlementCascade.
            if (child.parentEnvironmentId != null || visited.has(child.id)) continue;
            visited.add(child.id);
            const settled = child.settledOverride === "settled";
            const follows =
              action === "unsettle"
                ? settled &&
                  child.settlementSource !== "inactivity" &&
                  // Records from before provenance was kept match on the settle time.
                  (child.settledBy === undefined
                    ? child.settledAt != null &&
                      DateTime.toEpochMillis(child.settledAt) === settledAtMs
                    : child.settledBy === settledBy)
                : !settled;
            if (!follows) {
              // A card settled on its own keeps its clock, but its sub-runs still follow.
              if (settled) yield* walk(child.id);
              continue;
            }
            // A retried cascade replays the same command id and gets the same events back.
            const result = yield* orchestrator
              .dispatch({
                type: "thread.settlement.follow",
                commandId: CommandId.make(`${input.commandId}:cascade:${child.id}`),
                threadId: child.id,
                action,
                settledBy,
                settledAt,
              })
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Sub-run kept its settlement", {
                    threadId: child.id,
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              );
            const applied = result?.storedEvents.some(
              (stored) =>
                stored.event.threadId === child.id &&
                stored.event.type ===
                  (action === "unsettle" ? "thread.unsettled" : "thread.settled"),
            );
            // A sub-run that stayed active takes its own sub-runs along when it finishes.
            if (applied === true) yield* walk(child.id);
          }
        });
      yield* walk(input.threadId);
    });

    return SettlementCascade.of({ run });
  }),
);
