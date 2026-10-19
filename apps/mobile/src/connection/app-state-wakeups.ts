import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-reconnect"
>;

export function mobileApplicationActiveWakeup(
  leftActiveAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  return leftActiveAtMs !== null &&
    activeAtMs - leftActiveAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}

/**
 * Turns app state changes into resume wakeups, timing the absence from the
 * moment the app stopped being active.
 *
 * Locking the screen reports `inactive` at once, but iOS may suspend the app
 * before JS handles `background`; that event then arrives on resume, right
 * before `active`. Timing from `background` would read a long suspension as a
 * moment and keep a socket that went unread the whole time.
 */
export function makeApplicationActiveWakeups(
  initialState: string | null | undefined,
  nowMs: number,
): (state: string, nowMs: number) => MobileApplicationActiveWakeup | undefined {
  let leftActiveAtMs = initialState === "inactive" || initialState === "background" ? nowMs : null;
  return (state, atMs) => {
    if (state !== "active") {
      leftActiveAtMs ??= atMs;
      return undefined;
    }
    const wakeup = mobileApplicationActiveWakeup(leftActiveAtMs, atMs);
    leftActiveAtMs = null;
    return wakeup;
  };
}
