import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;

/** Offset from UTC in minutes, read from numeric date parts rather than the zone name. */
function zoneOffsetMinutes(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const wallClock = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  return Math.round((wallClock - Math.floor(at / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return "GMT";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return `GMT${minutes < 0 ? "-" : "+"}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

/**
 * Short label for the server zone a fixed-time schedule runs in (PST/PDT, GMT+7), at the run
 * time when there is one and now otherwise, so the editor and the list name it the same way.
 */
export function scheduleTimeZoneLabel(
  timeZone: string | undefined,
  runAt?: string | null,
): string | undefined {
  if (timeZone === undefined) return undefined;
  if (timeZone === "Etc/UTC" || timeZone === "UTC" || timeZone === "GMT") return "UTC";
  try {
    const at = runAt
      ? DateTime.toEpochMillis(DateTime.makeUnsafe(runAt))
      : DateTime.toEpochMillis(DateTime.nowUnsafe());
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value;
    // Hermes on iOS can return "GMT+7" as a bare "GMT" name, which would claim the wrong zone.
    return name === "GMT" ? offsetLabel(zoneOffsetMinutes(timeZone, at)) : name;
  } catch {
    return undefined;
  }
}
