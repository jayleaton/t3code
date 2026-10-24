import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeComponentLogger } from "./DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-realtime-limit");

/**
 * The hard RLIMIT_RTTIME from `/proc/self/limits`, in microseconds, or null
 * when unlimited. Undefined when the line is missing or unreadable.
 */
export function parseRealtimeTimeoutHardLimit(limits: string): number | null | undefined {
  const match = /^Max realtime timeout\s+(\S+)\s+(\S+)/m.exec(limits);
  if (match === null) return undefined;
  if (match[2] === "unlimited") return null;
  const hard = Number(match[2]);
  return Number.isSafeInteger(hard) ? hard : undefined;
}

/**
 * PipeWire's client RT module sets RLIMIT_RTTIME, soft and hard, to the
 * RTTimeUSecMax that xdg-desktop-portal reports, and the portal reports 0
 * without rtkit. Chromium loads libpipewire for Wayland screen capture. At 0
 * the kernel SIGKILLs a process as soon as one of its threads' CPU-time
 * timers fires, and every child (the backend, provider CLIs) inherits the
 * limit, which no unprivileged process can raise again. DISABLE_RTKIT makes
 * PipeWire skip the portal and rtkit, so it leaves the limit alone.
 *
 * A limit inherited from the launcher (a desktop shell that loaded PipeWire)
 * is already 0 here; only the user's session can fix that, so say so.
 */
export const protectRealtimeLimit = Effect.fn("desktop.realtimeLimit.protect")(function* () {
  process.env.DISABLE_RTKIT ??= "1";
  const fileSystem = yield* FileSystem.FileSystem;
  const limits = yield* fileSystem
    .readFileString("/proc/self/limits")
    .pipe(Effect.orElseSucceed(() => ""));
  if (parseRealtimeTimeoutHardLimit(limits) !== 0) return;
  yield* logWarning(
    "T3 Code started with a realtime CPU limit of 0, so the kernel kills its backend and agents when a thread CPU timer fires. Start T3 Code from its systemd unit or a terminal, or install and enable rtkit.",
  );
});
