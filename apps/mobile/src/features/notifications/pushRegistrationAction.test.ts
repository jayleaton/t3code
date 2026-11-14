import { describe, expect, it } from "vite-plus/test";

import { pushRegistrationAction } from "./pushRegistrationAction";

const base = {
  platform: "ios",
  permission: "granted",
  enabled: true,
  supportsPush: true,
  connected: true,
} as const;

describe("pushRegistrationAction", () => {
  it.each([
    ["registers a connected, capable, switched-on server", {}, "register"],
    ["unregisters a server switched off", { enabled: false }, "unregister"],
    ["unregisters once notifications are denied", { permission: "denied" }, "unregister"],
    ["waits until iOS has asked", { permission: "ask" }, "none"],
    ["waits while permission is read", { permission: "checking" }, "none"],
    [
      "waits for a switched-off server until iOS has asked",
      { permission: "ask", enabled: false },
      "none",
    ],
    ["skips servers without push", { supportsPush: false }, "none"],
    ["skips disconnected servers", { connected: false }, "none"],
    ["never registers on Android", { platform: "android" }, "none"],
  ] as const)("%s", (_name, override, expected) => {
    expect(pushRegistrationAction({ ...base, ...override })).toBe(expected);
  });
});
