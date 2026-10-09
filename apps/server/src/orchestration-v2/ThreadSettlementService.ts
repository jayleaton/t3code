import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { CommandId, type ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { resolveAutoSettlementAt } from "./autoSettlement.ts";

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

/** Identity of age settings; unrelated edits do not trigger a sweep. */
export function autoSettlementSettingsKey(
  settings: import("@t3tools/contracts").ServerSettings,
): string {
  return JSON.stringify([
    settings.sidebarAutoSettleAfterDays,
    Object.entries(settings.projectSettingsOverrides)
      .filter(([, entry]) => entry.sidebarAutoSettleAfterDays !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [projectId, entry.sidebarAutoSettleAfterDays]),
  ]);
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Settling a settled thread re-emits thread.settled with the same settledAt,
  // so this keeps the settle action to one run per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (threadId?: ThreadId) {
    const settings = yield* settingsService.getSettings;
    const enabled = (days: number | null | undefined) => days != null && days > 0;
    if (
      !enabled(settings.sidebarAutoSettleAfterDays) &&
      !Object.values(settings.projectSettingsOverrides).some((entry) =>
        enabled(entry.sidebarAutoSettleAfterDays),
      )
    )
      return;
    const threads = yield* projections.getSettlementCandidates(threadId);
    yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.gen(function* () {
          const current = resolveProjectSettings(
            yield* settingsService.getSettings,
            thread.projectId,
          ).settings;
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const settledAt = resolveAutoSettlementAt({
            thread,
            nowMs,
            autoSettleAfterDays: current.sidebarAutoSettleAfterDays,
          });
          if (settledAt === null || (yield* projections.hasActiveDescendants(thread.id))) return;
          // Age settlement belongs to this card alone. Child chats and subagents
          // retain their own clocks; only manual settlement cascades.
          yield* orchestrator.dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(
              `server:auto-settle:${thread.id}:${yield* crypto.randomUUIDv4}`,
            ),
            threadId: thread.id,
            snapshotAt: thread.updatedAt,
            settledAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    sweep(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  // Settling closes the thread's shells that sit at an idle prompt, so they stop
  // holding the worktree. A terminal running a command (a dev server, an
  // editor) stays for the user to close. Then the project's settle script runs
  // in the thread's own worktree; a thread in the shared checkout skips it,
  // because other threads may still be working there.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      // A thread re-engaged before this event ran keeps its shells.
      const settled = yield* projections.getThread(threadId);
      if (settled.settledOverride !== "settled") return;
      yield* terminals.closeIdle({ threadId });
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      // Closing and the worktree check wait on I/O. A thread re-engaged
      // meanwhile is working again, so its worktree is no place for cleanup.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      const settledAtMs =
        thread.settledAt == null ? null : DateTime.toEpochMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        // A clean exit closes the script's shell so it does not hold the worktree.
        observeCompletion: {},
      });
      // Recorded after a successful start, so a failed start retries on the next event.
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        yield* run.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("cleaning up a settled thread failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.settled":
        return cleanUpSettledThread(event.threadId);
      case "thread.pull-request-synced":
      case "provider-session.detached":
        return worker.enqueue(event.threadId);
      case "provider-session.updated":
        return event.payload.status !== "starting" && event.payload.status !== "running"
          ? worker.enqueue(event.threadId)
          : Effect.void;
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? worker.enqueue(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const events = orchestrator.streamDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);
