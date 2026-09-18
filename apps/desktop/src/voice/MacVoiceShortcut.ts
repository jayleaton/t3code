// @effect-diagnostics globalTimers:off -- Bounds initialization of the native input helper.
// @effect-diagnostics nodeBuiltinImport:off -- macOS input boundary; owns and stops its child process.
import * as NodeChildProcess from "node:child_process";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

const KEY_CODES: Readonly<Record<string, number>> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "9": 25,
  "7": 26,
  "8": 28,
  "0": 29,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
  " ": 49,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
};

export function macVoiceShortcut(value: string) {
  const chord = parseKeybindingShortcut(value);
  if (chord === null || KEY_CODES[chord.key] === undefined) return null;
  return {
    keyCode: KEY_CODES[chord.key]!,
    flags:
      (chord.shiftKey ? 1 << 17 : 0) |
      (chord.ctrlKey ? 1 << 18 : 0) |
      (chord.altKey ? 1 << 19 : 0) |
      (chord.metaKey || chord.modKey ? 1 << 20 : 0),
  };
}

const SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const key = Number(argv[0]);
  const flags = Number(argv[1]);
  const mask = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);
  let active = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const pressed = $.CGEventSourceKeyState(0, key) && ($.CGEventSourceFlagsState(0) & mask) === flags;
    if (pressed !== active) console.log(pressed ? "down" : "up");
    active = pressed;
    delay(0.02);
  }
}`;

export function startMacVoiceShortcut(
  value: string,
  onEvent: (event: "down" | "up" | "failed") => void,
): Promise<() => void> {
  const shortcut = macVoiceShortcut(value);
  if (shortcut === null)
    return Promise.reject(new Error("Choose a letter, number, Space, or F1–F20 shortcut."));
  const child = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", SCRIPT, String(shortcut.keyCode), String(shortcut.flags)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let ready = false;
    let stopped = false;
    let buffer = "";
    const stop = () => {
      if (!stopped) {
        stopped = true;
        clearTimeout(timeout);
        child.kill();
      }
    };
    const fail = (cause: Error) => {
      if (stopped) return;
      stop();
      if (ready) onEvent("failed");
      else reject(cause);
    };
    const timeout = setTimeout(() => fail(new Error("Global voice shortcut did not start.")), 5000);
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line === "ready" && !ready) {
          ready = true;
          clearTimeout(timeout);
          resolve(stop);
        } else if (ready && !stopped && (line === "down" || line === "up")) onEvent(line);
      }
    });
    child.once("error", fail);
    child.once("exit", () => fail(new Error("Global voice shortcut stopped.")));
  });
}
