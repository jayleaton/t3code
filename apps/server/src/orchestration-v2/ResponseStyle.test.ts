import { describe, expect, it } from "vite-plus/test";

import { withResponseStyle } from "./ResponseStyle.ts";

describe("withResponseStyle", () => {
  it("puts the same style note ahead of every message", () => {
    const first = withResponseStyle("Fix the login bug", true);
    const second = withResponseStyle("Now add a test", true);
    expect(first).toMatch(/^<response_style>[\s\S]*<\/response_style>\n\nFix the login bug$/);
    expect(first.replace("Fix the login bug", "")).toBe(second.replace("Now add a test", ""));
  });

  it("leaves the message alone when turned off", () => {
    expect(withResponseStyle("Fix the login bug", false)).toBe("Fix the login bug");
  });

  it.each(["/compact", "  /goal ship it", "/review"])("never touches %s", (command) => {
    expect(withResponseStyle(command, true)).toBe(command);
  });
});
