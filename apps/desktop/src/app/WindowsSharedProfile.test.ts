import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => false),
  relaunch: vi.fn(),
  exit: vi.fn(),
  getSwitchValue: vi.fn(() => ""),
}));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: () => "C:\\Users\\Alice\\AppData\\Roaming",
    commandLine: { getSwitchValue: mocks.getSwitchValue },
    relaunch: mocks.relaunch,
    exit: mocks.exit,
  },
}));

import {
  relaunchWithWindowsSharedProfile,
  sharedProfileRelaunchArgs,
} from "./WindowsSharedProfile.ts";

const input = {
  platform: "win32",
  brand: "agents",
  isPackaged: true,
  isDevelopment: false,
  userDataPath: "C:\\Users\\Alice\\AppData\\Roaming\\t3code",
  currentUserDataSwitch: "",
  args: ["--hidden", "t3code://oauth/callback?code=fixture"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Windows shared profile startup", () => {
  it("selects the shared encryption profile before native initialization and preserves launch arguments", () => {
    const args = sharedProfileRelaunchArgs(input)!;
    expect(args).toEqual([...input.args, `--user-data-dir=${input.userDataPath}`]);
    expect(
      sharedProfileRelaunchArgs({ ...input, args, currentUserDataSwitch: input.userDataPath }),
    ).toBeUndefined();
  });

  it("replaces either spelling of a stale startup profile without duplicating switches", () => {
    expect(
      sharedProfileRelaunchArgs({
        ...input,
        args: ["--user-data-dir", "C:\\fork", "--user-data-dir=C:\\other", "--hidden"],
      }),
    ).toEqual(["--hidden", `--user-data-dir=${input.userDataPath}`]);
  });

  it("recognizes equivalent Windows paths without entering a restart loop", () => {
    expect(
      sharedProfileRelaunchArgs({
        ...input,
        currentUserDataSwitch: "c:/users/alice/AppData/Roaming/t3code/",
      }),
    ).toBeUndefined();
  });

  for (const override of [
    { platform: "linux" },
    { platform: "darwin" },
    { brand: "t3" },
    { isPackaged: false },
    { isDevelopment: true },
  ]) {
    it(`leaves unrelated launches alone: ${JSON.stringify(override)}`, () => {
      expect(sharedProfileRelaunchArgs({ ...input, ...override })).toBeUndefined();
    });
  }

  it("stops the initial packaged process before application services can open state", () => {
    vi.stubGlobal("__T3CODE_DESKTOP_BRAND__", "agents");
    vi.stubGlobal("process", {
      ...process,
      platform: "win32",
      argv: ["T3 Agents.exe", "--hidden"],
      env: {},
    });
    expect(relaunchWithWindowsSharedProfile()).toBe(true);
    expect(mocks.relaunch).toHaveBeenCalledWith({
      args: ["--hidden", `--user-data-dir=${input.userDataPath}`],
    });
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });
});
