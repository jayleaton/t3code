import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { type CleanupCandidate, type CleanupContext, cleanupDecision } from "./cleanup.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const daysAgo = (days: number) => at(NOW - days * 86_400_000);
const inDays = (days: number) => at(NOW + days * 86_400_000);

const interval = { type: "interval", everyMs: 3_600_000 } as const;
const monthly = { type: "cron", expression: "0 9 1 * *", timezone: "UTC" } as const;
const once = { type: "once", runAt: daysAgo(10) } as const;
const webhook = { type: "webhook", signature: null } as const;

const task = (overrides: Partial<CleanupCandidate> = {}): CleanupCandidate => ({
  enabled: true,
  schedule: interval,
  runCount: 0,
  createdAt: daysAgo(60),
  updatedAt: daysAgo(60),
  lastRunAt: null,
  nextRunAt: inDays(1),
  lastRunStatus: "never",
  archivedAt: null,
  failingSince: null,
  consecutiveFailures: 0,
  threadId: null,
  ...overrides,
});

const context = (overrides: Partial<CleanupContext> = {}): CleanupContext => ({
  nowMs: NOW,
  running: false,
  threadArchivedAt: null,
  latestDeliveryAt: null,
  ...overrides,
});

const firedOnce = (days: number) =>
  task({
    enabled: false,
    schedule: once,
    runCount: 1,
    lastRunAt: daysAgo(days),
    updatedAt: daysAgo(days),
    nextRunAt: null,
    lastRunStatus: "succeeded",
  });

const paused = (days: number) =>
  task({ enabled: false, nextRunAt: null, runCount: 4, updatedAt: daysAgo(days) });

const failing = (days: number, failures: number) =>
  task({
    runCount: failures,
    lastRunStatus: "failed",
    failingSince: daysAgo(days),
    consecutiveFailures: failures,
  });

const threadBound = (overrides: Partial<CleanupCandidate> = {}) =>
  task({
    enabled: false,
    nextRunAt: null,
    threadId: ThreadId.make("thread-1"),
    updatedAt: daysAgo(1),
    ...overrides,
  });

const unusedWebhook = (overrides: Partial<CleanupCandidate> = {}) =>
  task({ schedule: webhook, nextRunAt: null, ...overrides });

describe("cleanupDecision", () => {
  it.each([
    ["1. a one-shot that fired 9 days ago stays", firedOnce(9), context(), "keep"],
    ["1. a one-shot that fired 10 days ago is archived", firedOnce(10), context(), "completed"],
    ["2. a recurring task paused 9 days ago stays", paused(9), context(), "keep"],
    ["2. a recurring task paused 10 days ago is archived", paused(10), context(), "paused"],
    ["2. an edit restarts the paused clock", paused(1), context(), "keep"],
    [
      "3. an enabled monthly cron whose last run was 25 days ago stays",
      task({ schedule: monthly, runCount: 3, lastRunAt: daysAgo(25), updatedAt: daysAgo(25) }),
      context(),
      "keep",
    ],
    ["4. three failures over 10 days archive", failing(10, 3), context(), "failing"],
    ["4. two failures over 10 days do not", failing(12, 2), context(), "keep"],
    ["4. three failures inside 10 days do not", failing(9, 3), context(), "keep"],
    [
      "5. a thread task is archived 10 days after its thread",
      threadBound(),
      context({ threadArchivedAt: daysAgo(10) }),
      "thread_archived",
    ],
    [
      "5. a thread task whose thread was archived 9 days ago stays",
      threadBound(),
      context({ threadArchivedAt: daysAgo(9) }),
      "keep",
    ],
    [
      "5. an agent task never follows its thread into the archive",
      threadBound({ profileId: "agent-1" }),
      context({ threadArchivedAt: daysAgo(40) }),
      "keep",
    ],
    [
      "6. a webhook with no deliveries is archived at 30 days",
      unusedWebhook(),
      context(),
      "webhook_unused",
    ],
    [
      "6. a webhook created 29 days ago stays",
      unusedWebhook({ createdAt: daysAgo(29), updatedAt: daysAgo(29) }),
      context(),
      "keep",
    ],
    [
      "6. one rejected delivery restarts the webhook clock",
      unusedWebhook(),
      context({ latestDeliveryAt: daysAgo(5) }),
      "keep",
    ],
    [
      "6. a triggered webhook is never archived",
      unusedWebhook({ runCount: 1, lastRunAt: daysAgo(200), lastRunStatus: "succeeded" }),
      context({ latestDeliveryAt: daysAgo(200) }),
      "keep",
    ],
    ["10. a running task is skipped", failing(40, 5), context({ running: true }), "keep"],
    [
      "10. a task the database marks running is skipped",
      { ...paused(40), lastRunStatus: "running" as const },
      context(),
      "keep",
    ],
  ] as const)("%s", (_name, candidate, ctx, expected) => {
    const decision = cleanupDecision(candidate, ctx);
    assert.equal(decision._tag === "archive" ? decision.reason : decision._tag, expected);
  });

  it("9. archived tasks are deleted 30 days after archive, not before", () => {
    const archived = (days: number) => ({ ...paused(90), archivedAt: daysAgo(days) });
    assert.equal(cleanupDecision(archived(29), context())._tag, "keep");
    assert.equal(cleanupDecision(archived(30), context())._tag, "delete");
  });
});
