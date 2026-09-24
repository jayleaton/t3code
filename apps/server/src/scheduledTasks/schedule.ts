import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type { ScheduledTaskSchedule } from "@t3tools/contracts";

export const isoFromMs = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const parseIsoMs = (value: string): number | null =>
  Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  });

/**
 * Checks a schedule a client or agent submitted and returns why it cannot be
 * used, or null when it can. Cron is limited to five fields so runs stay on
 * minute boundaries; Effect's parser would otherwise accept a seconds field.
 */
export function scheduleProblem(schedule: ScheduledTaskSchedule): string | null {
  if (schedule.kind === "once") {
    return parseIsoMs(schedule.runAt) === null
      ? `runAt "${schedule.runAt}" is not an ISO date-time.`
      : null;
  }
  if (schedule.expression.trim().split(/\s+/).length !== 5) {
    return `Cron "${schedule.expression}" must have five fields: minute hour day-of-month month weekday.`;
  }
  const parsed = Cron.parse(schedule.expression, schedule.timezone);
  return Result.isFailure(parsed)
    ? `Cron "${schedule.expression}" in ${schedule.timezone} is invalid: ${parsed.failure.message}.`
    : null;
}

/** Stores a one-time runAt in canonical ISO form so due checks can compare strings. */
export function normalizeSchedule(schedule: ScheduledTaskSchedule): ScheduledTaskSchedule {
  if (schedule.kind === "cron") return schedule;
  const runAtMs = parseIsoMs(schedule.runAt);
  return runAtMs === null ? schedule : { kind: "once", runAt: isoFromMs(runAtMs) };
}

/**
 * When an armed schedule next fires. A one-time schedule always reports its
 * runAt (the service disarms it after it runs), so a run missed while the
 * server was down is still due at startup. Cron reports its first match
 * strictly after `afterMs`.
 */
export function nextRunAt(schedule: ScheduledTaskSchedule, afterMs: number): string | null {
  if (schedule.kind === "once") {
    const runAtMs = parseIsoMs(schedule.runAt);
    return runAtMs === null ? null : isoFromMs(runAtMs);
  }
  const parsed = Cron.parse(schedule.expression, schedule.timezone);
  if (Result.isFailure(parsed)) return null;
  return Cron.next(parsed.success, afterMs).toISOString();
}
