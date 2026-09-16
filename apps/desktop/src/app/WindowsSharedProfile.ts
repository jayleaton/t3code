/* eslint-disable t3code/no-global-process-runtime -- Must relaunch before the Effect runtime or application services start. */
// @effect-diagnostics nodeBuiltinImport:off - Windows must choose its encryption profile before Electron initializes, ahead of asynchronous application services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Electron from "electron";

declare const __T3CODE_DESKTOP_BRAND__: string | undefined;

export function sharedProfileRelaunchArgs(input: {
  readonly platform: string;
  readonly brand: string;
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly userDataPath: string;
  readonly currentUserDataSwitch: string;
  readonly args: readonly string[];
}): string[] | undefined {
  if (
    input.platform !== "win32" ||
    input.brand !== "agents" ||
    !input.isPackaged ||
    input.isDevelopment
  )
    return undefined;
  const normalize = (value: string) => NodePath.win32.resolve(value).toLowerCase();
  if (
    input.currentUserDataSwitch &&
    normalize(input.currentUserDataSwitch) === normalize(input.userDataPath)
  ) {
    return undefined;
  }
  const args: string[] = [];
  for (let index = 0; index < input.args.length; index++) {
    const arg = input.args[index]!;
    if (arg === "--user-data-dir") {
      index++;
      continue;
    }
    if (arg.startsWith("--user-data-dir=")) continue;
    args.push(arg);
  }
  return [...args, `--user-data-dir=${input.userDataPath}`];
}

/** Returns true when this process must stop before opening any application state. */
export function relaunchWithWindowsSharedProfile(): boolean {
  const brand = typeof __T3CODE_DESKTOP_BRAND__ === "undefined" ? "t3" : __T3CODE_DESKTOP_BRAND__;
  if (process.platform !== "win32" || brand !== "agents" || !Electron.app.isPackaged) return false;
  const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL?.trim());
  if (isDevelopment) return false;
  const appData = Electron.app.getPath("appData");
  const legacy = NodePath.win32.join(appData, "T3 Code (Alpha)");
  const userDataPath = NodeFS.existsSync(legacy) ? legacy : NodePath.win32.join(appData, "t3code");
  const args = sharedProfileRelaunchArgs({
    platform: process.platform,
    brand,
    isPackaged: Electron.app.isPackaged,
    isDevelopment,
    userDataPath,
    currentUserDataSwitch: Electron.app.commandLine.getSwitchValue("user-data-dir"),
    args: process.argv.slice(1),
  });
  if (!args) return false;
  // On Windows OSCrypt reads Local State before the JS entry point. setPath()
  // alone changes the browser profile but leaves encryption using the fork's key.
  // A startup switch selects the shared key before native initialization as well.
  Electron.app.relaunch({ args });
  Electron.app.exit(0);
  return true;
}
