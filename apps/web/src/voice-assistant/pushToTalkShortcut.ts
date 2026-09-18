import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import { formatShortcutLabel, shortcutKeyFromEvent } from "../keybindings";
import { keybindingFromKeyboardEvent } from "../components/settings/KeybindingsSettings.logic";

export const DEFAULT_VOICE_PUSH_TO_TALK_SHORTCUT = "mod+alt+space";

/** Function keys are the one modifier-less shortcut that is safe to gobble. */
const FUNCTION_KEY_PATTERN = /^f([1-9]|1[0-9]|2[0-4])$/;

export type VoiceShortcutCapture =
  | { readonly kind: "set"; readonly value: string }
  | { readonly kind: "clear" }
  | { readonly kind: "cancel" }
  | { readonly kind: "ignore" };

/**
 * Turns a keydown into a stored push-to-talk shortcut. Mirrors the keybinding
 * recorder, but additionally allows a bare function key (F1-F24) so users who
 * prefer a single key can have one without hijacking ordinary typing.
 */
export function captureVoiceShortcut(
  event: KeyboardEvent,
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): VoiceShortcutCapture {
  if (event.key === "Tab") return { kind: "ignore" };
  if (event.key === "Escape") return { kind: "cancel" };
  if (event.key === "Backspace" || event.key === "Delete") return { kind: "clear" };

  const chord = keybindingFromKeyboardEvent(event, platform);
  if (chord !== null) return { kind: "set", value: chord };

  const bare = shortcutKeyFromEvent(event);
  if (FUNCTION_KEY_PATTERN.test(bare)) return { kind: "set", value: bare };
  return { kind: "ignore" };
}

export function formatVoiceShortcut(
  value: string,
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): string {
  if (value.trim().length === 0) return "Not set";
  const parsed = parseKeybindingShortcut(value);
  return parsed === null ? "Not set" : formatShortcutLabel(parsed, platform);
}

/**
 * Whether a live keyboard event matches the stored shortcut. Only used for the
 * in-app hold gesture; the desktop app registers the same chord as a global
 * accelerator separately.
 */
export function matchesVoiceShortcut(
  event: KeyboardEvent,
  value: string,
  platform: string = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (value.trim().length === 0) return false;
  const parsed = parseKeybindingShortcut(value);
  if (parsed === null) return false;
  const useMetaForMod = /mac|iphone|ipad|ipod/i.test(platform);
  const expectedMeta = parsed.metaKey || (parsed.modKey && useMetaForMod);
  const expectedCtrl = parsed.ctrlKey || (parsed.modKey && !useMetaForMod);
  if (
    event.metaKey !== expectedMeta ||
    event.ctrlKey !== expectedCtrl ||
    event.shiftKey !== parsed.shiftKey ||
    event.altKey !== parsed.altKey
  ) {
    return false;
  }
  return shortcutKeyFromEvent(event) === parsed.key;
}
