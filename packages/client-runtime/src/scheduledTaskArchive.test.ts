import { describe, expect, it } from "vite-plus/test";

import {
  scheduledTaskArchiveLabel,
  scheduledTaskRestoreNeedsEditor,
  scheduledTasksInView,
} from "./scheduledTaskArchive.ts";

describe("archived scheduled tasks", () => {
  it("lists archived tasks only under Archived", () => {
    const active: { id: string; archivedAt?: string } = { id: "active" };
    const archived = { id: "archived", archivedAt: "2026-11-01T00:00:00.000Z" };
    expect(scheduledTasksInView([active, archived], "active")).toEqual([active]);
    expect(scheduledTasksInView([active, archived], "archived")).toEqual([archived]);
  });

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
