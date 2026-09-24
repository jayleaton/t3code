import { describe, expect, it } from "vite-plus/test";

import {
  cronToRepeatForm,
  describeSchedule,
  repeatFormToCron,
  type RepeatForm,
} from "./scheduledTasks.logic";

const form = (patch: Partial<RepeatForm>): RepeatForm => ({
  preset: "daily",
  time: "07:05",
  weekday: 1,
  expression: "",
  ...patch,
});

describe("scheduled task repeat presets", () => {
  it("round-trips every preset through cron", () => {
    for (const preset of ["daily", "weekdays", "weekly", "hourly"] as const) {
      const original = form({ preset, weekday: 3, time: preset === "hourly" ? "00:15" : "07:05" });
      const reopened = cronToRepeatForm(repeatFormToCron(original));
      expect(reopened.preset).toBe(preset);
      expect(reopened.time).toBe(original.time);
      if (preset === "weekly") expect(reopened.weekday).toBe(3);
    }
  });

  it("keeps hand-written cron as custom", () => {
    expect(cronToRepeatForm("0 7 1 * *").preset).toBe("custom");
    expect(cronToRepeatForm("*/15 9-17 * * 1-5").preset).toBe("custom");
    expect(repeatFormToCron(form({ preset: "custom", expression: " 0 7 1 * * " }))).toBe(
      "0 7 1 * *",
    );
  });

  it("describes schedules and names foreign time zones", () => {
    const at = (iso: string) => `at ${iso}`;
    expect(
      describeSchedule({ kind: "cron", expression: "0 7 * * 1-5", timezone: "UTC" }, at, "UTC"),
    ).toBe("Weekdays at 07:00");
    expect(
      describeSchedule(
        { kind: "cron", expression: "30 6 * * 0", timezone: "Asia/Bangkok" },
        at,
        "UTC",
      ),
    ).toBe("Every Sunday at 06:30 (Asia/Bangkok)");
    expect(describeSchedule({ kind: "once", runAt: "2026-09-25T02:00:00.000Z" }, at, "UTC")).toBe(
      "Once · at 2026-09-25T02:00:00.000Z",
    );
  });
});
