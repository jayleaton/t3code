import { describe, expect, it } from "vite-plus/test";

import {
  captureVoiceShortcut,
  formatVoiceShortcut,
  matchesVoiceShortcut,
} from "./pushToTalkShortcut";

const MAC = "MacIntel";
const WIN = "Win32";

const keyEvent = (init: {
  readonly key: string;
  readonly code?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}): KeyboardEvent =>
  ({
    key: init.key,
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  }) as KeyboardEvent;

describe("captureVoiceShortcut", () => {
  it("records a modifier chord as a canonical shortcut string", () => {
    expect(
      captureVoiceShortcut(keyEvent({ key: " ", code: "Space", metaKey: true, altKey: true }), MAC),
    ).toEqual({ kind: "set", value: "mod+alt+space" });
  });

  it("records a bare function key, which is safe to gobble", () => {
    expect(captureVoiceShortcut(keyEvent({ key: "F8", code: "F8" }), MAC)).toEqual({
      kind: "set",
      value: "f8",
    });
  });

  it("ignores a bare letter that would hijack typing", () => {
    expect(captureVoiceShortcut(keyEvent({ key: "a", code: "KeyA" }), MAC)).toEqual({
      kind: "ignore",
    });
  });

  it("treats Escape as cancel and Backspace/Delete as clear", () => {
    expect(captureVoiceShortcut(keyEvent({ key: "Escape" }), MAC)).toEqual({ kind: "cancel" });
    expect(captureVoiceShortcut(keyEvent({ key: "Backspace" }), MAC)).toEqual({ kind: "clear" });
    expect(captureVoiceShortcut(keyEvent({ key: "Delete" }), MAC)).toEqual({ kind: "clear" });
  });

  it("resolves mod to Control on non-Apple platforms", () => {
    expect(captureVoiceShortcut(keyEvent({ key: "m", code: "KeyM", ctrlKey: true }), WIN)).toEqual({
      kind: "set",
      value: "mod+m",
    });
  });
});

describe("matchesVoiceShortcut", () => {
  it("matches the platform mod key", () => {
    const event = keyEvent({ key: " ", code: "Space", metaKey: true, altKey: true });
    expect(matchesVoiceShortcut(event, "mod+alt+space", MAC)).toBe(true);
    expect(matchesVoiceShortcut(event, "mod+alt+space", WIN)).toBe(false);
  });

  it("does not match when a modifier differs", () => {
    const event = keyEvent({ key: " ", code: "Space", metaKey: true });
    expect(matchesVoiceShortcut(event, "mod+alt+space", MAC)).toBe(false);
  });

  it("matches a bare function key", () => {
    expect(matchesVoiceShortcut(keyEvent({ key: "F8", code: "F8" }), "f8", MAC)).toBe(true);
  });

  it("never matches an unset shortcut", () => {
    expect(
      matchesVoiceShortcut(keyEvent({ key: " ", code: "Space", metaKey: true }), "", MAC),
    ).toBe(false);
  });
});

describe("formatVoiceShortcut", () => {
  it("labels an unset shortcut", () => {
    expect(formatVoiceShortcut("", MAC)).toBe("Not set");
  });

  it("formats the chord for display", () => {
    expect(formatVoiceShortcut("mod+alt+space", MAC)).toContain("Space");
    expect(formatVoiceShortcut("mod+alt+space", WIN)).toContain("Space");
  });
});
