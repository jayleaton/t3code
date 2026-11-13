import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  SCHEDULED_TASK_FILTERS,
  scheduledTaskArchiveLabel,
  scheduledTaskMatchesFilter,
  scheduledTaskRestoreNeedsEditor,
} from "./scheduledTaskArchive.ts";

describe("archived scheduled tasks", () => {
  const threadId = ThreadId.make("thread");
  const tasks = {
    agent: { profileId: "reviewer", threadId, threadMode: "continue" },
    thread: { threadId, threadMode: "fresh_session" },
    new_thread: { threadId: null, threadMode: "new_thread" },
    legacyThread: { threadId },
    archivedAgent: { profileId: "reviewer", threadId: null, archivedAt: "2026-11-01T00:00:00Z" },
  } as const;

  it.each([
    ["all", ["agent", "thread", "new_thread", "legacyThread"]],
    ["agent", ["agent"]],
    ["thread", ["thread", "legacyThread"]],
    ["new_thread", ["new_thread"]],
    ["archived", ["archivedAgent"]],
  ] as const)(
    "filter %s lists its targets, and archived tasks only under Archived",
    (filter, ids) => {
      expect(
        Object.entries(tasks)
          .filter(([, task]) => scheduledTaskMatchesFilter(task, filter))
          .map(([id]) => id),
      ).toEqual(ids);
      expect(SCHEDULED_TASK_FILTERS.map((option) => option.value)).toContain(filter);
    },
  );

  it.each([
    ["completed", "Archived: finished its one-time run"],
    ["paused", "Archived: paused for 10 days"],
    ["failing", "Archived: failing for 10 days"],
    ["thread_archived", "Archived: its thread was archived"],
    ["webhook_unused", "Archived: never triggered in 30 days"],
    ["added_later", "Archived"],
    [undefined, "Archived"],
  ])("labels reason %s", (archiveReason, label) => {
    expect(scheduledTaskArchiveLabel({ archiveReason })).toBe(label);
  });

  it("restores a one-time task whose time passed through the editor", () => {
    const now = Date.parse("2026-11-13T00:00:00.000Z");
    const once = (runAt: string) => ({ schedule: { type: "once", runAt } as const });
    expect(scheduledTaskRestoreNeedsEditor(once("2026-11-12T00:00:00.000Z"), now)).toBe(true);
    expect(scheduledTaskRestoreNeedsEditor(once("2026-11-14T00:00:00.000Z"), now)).toBe(false);
    expect(
      scheduledTaskRestoreNeedsEditor({ schedule: { type: "interval", everyMs: 60_000 } }, now),
    ).toBe(false);
  });
});
