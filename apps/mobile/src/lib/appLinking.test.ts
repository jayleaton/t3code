import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "t3code-personal://",
    "t3code-personal:///",
    "t3code-personal-dev://",
    "t3code-personal-preview://",
  ])("ignores scheme-only URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "t3code-personal://threads/env-1/thread-1",
    "t3code-personal://pair?pairingUrl=x",
    "t3code-personal-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each([
    "t3code-personal://expo-development-client/?url=x",
    "t3code-personal://expo-sharing/anything",
  ])("ignores lifecycle URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });
});
