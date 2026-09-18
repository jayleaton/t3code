import { describe, expect, it } from "vite-plus/test";
import { macVoiceShortcut } from "./MacVoiceShortcut.ts";

describe("macOS voice shortcut", () => {
  it("maps the default chord and function keys to physical key states", () => {
    expect(macVoiceShortcut("mod+alt+space")).toEqual({
      keyCode: 49,
      flags: (1 << 19) | (1 << 20),
    });
    expect(macVoiceShortcut("f8")).toEqual({ keyCode: 100, flags: 0 });
    expect(macVoiceShortcut("ctrl+shift+a")).toEqual({ keyCode: 0, flags: (1 << 17) | (1 << 18) });
  });
  it("reports unsupported keys instead of silently registering a different shortcut", () => {
    expect(macVoiceShortcut("f24")).toBeNull();
    expect(macVoiceShortcut("")).toBeNull();
  });
});
