import { expect, it, vi } from "vite-plus/test";

import { scheduleTimeZoneLabel } from "./scheduledTaskTimeZone.ts";

it("uses short names instead of full IANA zones", () => {
  expect(scheduleTimeZoneLabel(undefined)).toBeUndefined();
  expect(scheduleTimeZoneLabel("Unsupported/Zone")).toBeUndefined();
  expect(scheduleTimeZoneLabel("Etc/UTC")).toBe("UTC");
  expect(scheduleTimeZoneLabel("America/Los_Angeles")).toMatch(/^P[DS]T$/);
  expect(scheduleTimeZoneLabel("Asia/Bangkok")).toBe("GMT+7");
  expect(scheduleTimeZoneLabel("America/Los_Angeles", "2027-01-15T17:00:00Z")).toBe("PST");
  expect(scheduleTimeZoneLabel("America/Los_Angeles", "2027-07-15T16:00:00Z")).toBe("PDT");
});

it("keeps the offset when the zone name part drops it", () => {
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  // Mimics an Intl that returns "GMT+7" as a "GMT" name followed by a "+7" literal.
  using _parts = vi
    .spyOn(Intl.DateTimeFormat.prototype, "formatToParts")
    .mockImplementation(function (this: Intl.DateTimeFormat, date) {
      return formatToParts.call(this, date).flatMap((part) =>
        part.type === "timeZoneName" && /^GMT[+-]/.test(part.value)
          ? [
              { type: "timeZoneName" as const, value: "GMT" },
              { type: "literal" as const, value: part.value.slice(3) },
            ]
          : [part],
      );
    });
  expect(scheduleTimeZoneLabel("Asia/Bangkok", "2026-11-16T02:00:00Z")).toBe("GMT+7");
  expect(scheduleTimeZoneLabel("Asia/Kolkata", "2026-11-16T03:30:00Z")).toBe("GMT+5:30");
  expect(scheduleTimeZoneLabel("Europe/London", "2027-01-15T09:00:00Z")).toBe("GMT");
});
