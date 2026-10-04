import { assert, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadSettlementService from "./ThreadSettlementService.ts";
import * as AutoSettlement from "./autoSettlement.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

type SettlementShell = OrchestrationV2ThreadShell &
  OrchestrationV2AppThread &
  Pick<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">;

// A fixture's user message is one the user wrote unless the test sets
// latestUserAuthoredMessageAt on its own.
function shell(overrides: Partial<SettlementShell> = {}): SettlementShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: overrides.latestUserMessageAt ?? null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("isAutoSettlementCandidate", () => {
  it("excludes settled, pinned, blocked, and working cards", () => {
    expect(AutoSettlement.isAutoSettlementCandidate(shell(), NOW_MS)).toBe(true);
    expect(AutoSettlement.isAutoSettlementCandidate(shell({ archivedAt: at(-1) }), NOW_MS)).toBe(
      false,
    );
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ settledOverride: "settled" }), NOW_MS),
    ).toBe(false);
    expect(AutoSettlement.isAutoSettlementCandidate(shell({ pinnedAt: at(-1) }), NOW_MS)).toBe(
      false,
    );
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ autoSettleDisabledAt: at(-1) }), NOW_MS),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ activityRunStatus: "running" }), NOW_MS),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("question"),
            kind: "user_input",
            createdAt: at(-DAY_MS),
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }] }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("settles a thread whose only background work is a command left running", () => {
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({
          pendingBackgroundTasks: [
            { taskId: "dev", kind: "command", description: "vp run dev --share" },
          ],
        }),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("keeps snoozed threads parked until they wake early on error or completion", () => {
    const snoozed = shell({
      snoozedUntil: at(60 * 60 * 1_000),
      snoozedAt: at(-60 * 60 * 1_000),
    });
    expect(AutoSettlement.isAutoSettlementCandidate(snoozed, NOW_MS)).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, latestRunCompletedAt: at(-30 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(true);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: at(-2 * 60 * 60 * 1_000) }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: snoozed.snoozedAt }),
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      AutoSettlement.isAutoSettlementCandidate(
        shell({ ...snoozed, status: "failed", latestRunCompletedAt: null }),
        NOW_MS,
      ),
    ).toBe(false);
    // Expired snooze is no longer a park.
    expect(
      AutoSettlement.isAutoSettlementCandidate(shell({ ...snoozed, snoozedUntil: at(-1) }), NOW_MS),
    ).toBe(true);
  });
});

describe("threadHasQueuedTurnStart", () => {
  it("holds a fresh unadopted user message inside the grace window only", () => {
    const fresh = shell({ latestUserMessageAt: at(-1_000) });
    expect(AutoSettlement.threadHasQueuedTurnStart(fresh, NOW_MS)).toBe(true);
    // Adoption stamps the run with the message time, clearing the hold.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
        shell({
          latestUserMessageAt: at(-1_000),
          latestRunId: "run-1" as never,
          latestRunRequestedAt: at(-500),
        }),
        NOW_MS,
      ),
    ).toBe(false);
    // Outside the grace window the stale message no longer blocks.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-AutoSettlement.QUEUED_TURN_START_GRACE_MS - 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // Client clocks ahead of the server must not extend the hold.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(AutoSettlement.QUEUED_TURN_START_GRACE_MS + 1) }),
        NOW_MS,
      ),
    ).toBe(false);
    // A failed start clears the hold immediately.
    expect(
      AutoSettlement.threadHasQueuedTurnStart(
        shell({ latestUserMessageAt: at(-1_000), status: "failed" }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe("age settlement", () => {
  it.each(["queued", "preparing", "starting", "running", "waiting"] as const)(
    "keeps %s cards active even when their idle timestamps are old",
    (status) => {
      expect(
        AutoSettlement.resolveAutoSettlementAt({
          thread: shell({ status }),
          nowMs: NOW_MS,
          autoSettleAfterDays: 3,
        }),
      ).toBeNull();
    },
  );

  it.each(["monitor", "subagent", "background_task"] as const)(
    "keeps a completed card with a pending %s active",
    (kind) => {
      expect(
        AutoSettlement.resolveAutoSettlementAt({
          thread: shell({
            status: "completed",
            latestRunCompletedAt: at(-10 * DAY_MS),
            pendingBackgroundTasks: [{ taskId: "work", kind }],
          }),
          nowMs: NOW_MS,
          autoSettleAfterDays: 3,
        }),
      ).toBeNull();
    },
  );

  it("keeps finished cards unsettled for the full period, including the boundary", () => {
    const thread = shell({ latestRunCompletedAt: at(-3 * DAY_MS) });
    expect(
      AutoSettlement.resolveAutoSettlementAt({ thread, nowMs: NOW_MS - 1, autoSettleAfterDays: 3 }),
    ).toBeNull();
    expect(
      AutoSettlement.resolveAutoSettlementAt({ thread, nowMs: NOW_MS, autoSettleAfterDays: 3 }),
    ).toEqual(at(-3 * DAY_MS));
  });
  it.each([null, 0])("disables age settlement with %s", (autoSettleAfterDays) => {
    expect(
      AutoSettlement.resolveAutoSettlementAt({
        thread: shell(),
        nowMs: NOW_MS,
        autoSettleAfterDays,
      }),
    ).toBeNull();
  });
  it("restarts the clock on unsettle, visits, messages, new runs, and background completion", () => {
    for (const activity of [
      { unsettledAt: at(-DAY_MS), settledOverride: "active" as const },
      { lastVisitedAt: at(-DAY_MS) },
      { updatedAt: at(-DAY_MS) },
      { latestUserMessageAt: at(-DAY_MS) },
      { latestRunRequestedAt: at(-DAY_MS) },
      { latestRunCompletedAt: at(-DAY_MS) },
      { latestBackgroundActivityAt: at(-DAY_MS) },
    ]) {
      const thread = { ...shell(), ...activity };
      expect(
        AutoSettlement.resolveAutoSettlementAt({ thread, nowMs: NOW_MS, autoSettleAfterDays: 3 }),
      ).toBeNull();
      expect(
        AutoSettlement.resolveAutoSettlementAt({
          thread,
          nowMs: NOW_MS + 2 * DAY_MS,
          autoSettleAfterDays: 3,
        }),
      ).toEqual(at(-DAY_MS));
    }
  });
});

const makeHarness = Effect.fn(function* (input: {
  threads: ReadonlyArray<SettlementShell>;
  settings?: ContractServerSettings;
  activeDescendants?: ReadonlySet<string>;
}) {
  const candidates = yield* Ref.make(input.threads);
  const reads = yield* Queue.unbounded<ThreadId | undefined>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const closedIdle = yield* Queue.unbounded<string>();
  const activation = yield* Deferred.make<void>();
  const settings = yield* Ref.make(input.settings ?? DEFAULT_SERVER_SETTINGS);
  const settingsChanges = yield* Queue.unbounded<ContractServerSettings>();
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getSettlementCandidates: (id) =>
        Ref.get(candidates).pipe(
          Effect.map((all) => (id === undefined ? all : all.filter((thread) => thread.id === id))),
          Effect.tap(() => Queue.offer(reads, id)),
        ),
      hasActiveDescendants: (id) => Effect.succeed(input.activeDescendants?.has(id) ?? false),
      getThread: (id) =>
        Ref.get(candidates).pipe(
          Effect.map((all) => {
            const thread = all.find((thread) => thread.id === id)!;
            return { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null };
          }),
        ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromQueue(events),
      dispatch: (command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Ref.get(settings),
      subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
    }),
    Layer.mock(TerminalManager.TerminalManager)({
      closeIdle: ({ threadId }) =>
        Queue.offer(closedIdle, ThreadId.make(threadId)).pipe(Effect.asVoid),
    }),
    Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  return {
    candidates,
    reads,
    events,
    commands,
    closedIdle,
    layer: ThreadSettlementService.layer.pipe(Layer.provide(dependencies)),
    start: (service: ThreadSettlementService.ThreadSettlementServiceV2["Service"]) =>
      Effect.gen(function* () {
        yield* service.start();
        yield* Deferred.succeed(activation, undefined);
        yield* Queue.take(reads);
        yield* service.drain;
      }),
  };
});

it.effect("sweeps on the fake clock with project overrides and active descendants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const enabled = ProjectId.make("enabled");
      const disabled = ProjectId.make("disabled");
      const fixture = yield* makeHarness({
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          sidebarAutoSettleAfterDays: 3,
          projectSettingsOverrides: { [disabled]: { sidebarAutoSettleAfterDays: 0 } },
        },
        activeDescendants: new Set(["busy-parent"]),
        threads: [
          shell({
            id: ThreadId.make("recent"),
            projectId: enabled,
            latestRunCompletedAt: at(-3 * DAY_MS + 60_000),
          }),
          shell({ id: ThreadId.make("old"), projectId: enabled }),
          shell({ id: ThreadId.make("busy-parent"), projectId: enabled }),
          shell({ id: ThreadId.make("disabled"), projectId: disabled }),
          shell({
            id: ThreadId.make("monitor"),
            projectId: enabled,
            pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" }],
          }),
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        const first = yield* Ref.get(fixture.commands);
        assert.deepEqual(
          first.map((command) => ("threadId" in command ? command.threadId : null)),
          [ThreadId.make("old")],
        );
        assert.equal(first[0]?.type, "thread.auto-settle");
        yield* Ref.update(fixture.candidates, (all) => all.filter((thread) => thread.id !== "old"));
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.reads);
        yield* service.drain;
        const recent = (yield* Ref.get(fixture.commands)).find(
          (command) => "threadId" in command && command.threadId === "recent",
        );
        assert.isDefined(recent);
        if (recent?.type === "thread.auto-settle") {
          assert.deepEqual(recent.snapshotAt, at(-10 * DAY_MS));
          assert.deepEqual(recent.settledAt, at(-3 * DAY_MS + 60_000));
          assert.match(recent.commandId, /^server:auto-settle:recent:/);
        }
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("settles an old child chat by its own age and leaves its recent parent untouched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const parent = ThreadId.make("parent");
      const fixture = yield* makeHarness({
        threads: [
          shell({ id: parent, latestUserMessageAt: at(-DAY_MS) }),
          shell({
            id: ThreadId.make("child"),
            lineage: {
              rootThreadId: parent,
              parentThreadId: parent,
              relationshipToParent: "fork",
            },
          }),
        ],
      });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        assert.deepEqual(
          (yield* Ref.get(fixture.commands)).map((command) =>
            "threadId" in command ? command.threadId : null,
          ),
          [ThreadId.make("child")],
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("provider detachment requests a single-card sweep without settling a recent card", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const thread = shell({ id: ThreadId.make("finished"), latestRunCompletedAt: at(0) });
      const fixture = yield* makeHarness({ threads: [thread] });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        yield* Queue.offer(fixture.events, {
          type: "provider-session.detached",
          id: EventId.make("detached"),
          threadId: thread.id,
          occurredAt: at(0),
          payload: {
            providerSessionId: ProviderSessionId.make("finished-session"),
            detachedAt: at(0),
          },
        });
        assert.equal(yield* Queue.take(fixture.reads), thread.id);
        yield* service.drain;
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("keeps terminals when a settled card was re-engaged before the event was handled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const resumed = shell({
        id: ThreadId.make("resumed"),
        settledOverride: "active",
        unsettledAt: at(0),
      });
      const marker = shell({
        id: ThreadId.make("marker"),
        settledOverride: "settled",
        settledAt: at(0),
      });
      const fixture = yield* makeHarness({ threads: [resumed, marker] });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        for (const thread of [resumed, marker]) {
          yield* Queue.offer(fixture.events, {
            type: "thread.settled",
            id: EventId.make(`settled:${thread.id}`),
            threadId: thread.id,
            occurredAt: at(0),
            payload: {
              ...thread,
              lastVisitedAt: thread.lastVisitedAt ?? null,
              settledOverride: "settled",
              settledAt: at(0),
            },
          });
        }
        // The stream handles events in order; only the later card should close.
        assert.equal(yield* Queue.take(fixture.closedIdle), marker.id);
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);

it.effect("an unsettled card gets a full new idle period on the sweep clock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const thread = shell({ settledOverride: "active", unsettledAt: at(0) });
      const fixture = yield* makeHarness({ threads: [thread] });
      yield* Effect.gen(function* () {
        const service = yield* ThreadSettlementService.ThreadSettlementServiceV2;
        yield* fixture.start(service);
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        yield* TestClock.adjust(3 * DAY_MS - 60_000);
        yield* Queue.take(fixture.reads);
        yield* service.drain;
        assert.deepEqual(yield* Ref.get(fixture.commands), []);
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.reads);
        yield* service.drain;
        const commands = yield* Ref.get(fixture.commands);
        assert.equal(commands.length, 1);
        assert.equal(commands[0]?.type, "thread.auto-settle");
        if (commands[0]?.type === "thread.auto-settle") {
          assert.deepEqual(commands[0].settledAt, at(0));
        }
      }).pipe(Effect.provide(fixture.layer));
    }),
  ),
);
