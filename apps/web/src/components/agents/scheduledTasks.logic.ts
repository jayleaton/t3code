import type { ScheduledTaskSchedule } from "@t3tools/contracts";

/** The repeat patterns the editor offers; anything else is edited as raw cron. */
export type RepeatPreset = "daily" | "weekdays" | "weekly" | "hourly" | "custom";

export interface RepeatForm {
  readonly preset: RepeatPreset;
  /** HH:MM, 24-hour. Hourly uses only the minutes. */
  readonly time: string;
  /** 0 = Sunday … 6 = Saturday, for weekly. */
  readonly weekday: number;
  readonly expression: string;
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (value: number) => String(value).padStart(2, "0");

function splitTime(time: string): { hour: number; minute: number } {
  const [hour = 0, minute = 0] = time.split(":").map((part) => Number.parseInt(part, 10));
  return { hour: Number.isNaN(hour) ? 0 : hour, minute: Number.isNaN(minute) ? 0 : minute };
}

export function repeatFormToCron(form: RepeatForm): string {
  const { hour, minute } = splitTime(form.time);
  switch (form.preset) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${form.weekday}`;
    case "hourly":
      return `${minute} * * * *`;
    case "custom":
      return form.expression.trim();
  }
}

const NUMBER = /^\d{1,2}$/;

/** Recognises the cron the presets produce so an existing task reopens on its preset. */
export function cronToRepeatForm(expression: string): RepeatForm {
  const fields = expression.trim().split(/\s+/);
  const custom: RepeatForm = { preset: "custom", time: "07:00", weekday: 1, expression };
  if (fields.length !== 5) return custom;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  if (!NUMBER.test(minute) || day !== "*" || month !== "*") return custom;
  if (hour === "*" && weekday === "*") {
    return { ...custom, preset: "hourly", time: `00:${pad(Number(minute))}` };
  }
  if (!NUMBER.test(hour)) return custom;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (weekday === "*") return { ...custom, preset: "daily", time };
  if (weekday === "1-5") return { ...custom, preset: "weekdays", time };
  if (/^[0-6]$/.test(weekday))
    return { ...custom, preset: "weekly", time, weekday: Number(weekday) };
  return custom;
}

/** Plain-language schedule, naming the time zone only when it is not the viewer's. */
export function describeSchedule(
  schedule: ScheduledTaskSchedule,
  formatInstant: (iso: string) => string,
  viewerTimeZone: string = localTimeZone(),
): string {
  if (schedule.kind === "once") return `Once · ${formatInstant(schedule.runAt)}`;
  const form = cronToRepeatForm(schedule.expression);
  const zone = schedule.timezone === viewerTimeZone ? "" : ` (${schedule.timezone})`;
  switch (form.preset) {
    case "daily":
      return `Every day at ${form.time}${zone}`;
    case "weekdays":
      return `Weekdays at ${form.time}${zone}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[form.weekday]} at ${form.time}${zone}`;
    case "hourly":
      return `Every hour at :${form.time.slice(3)}${zone}`;
    case "custom":
      return `Cron ${schedule.expression}${zone}`;
  }
}

/** `<input type="datetime-local">` value for an instant, in the viewer's zone. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** The instant a `datetime-local` value names in the viewer's zone, or null when incomplete. */
export function localInputToIso(value: string): string | null {
  if (value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
