import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { THREAD_JUMP_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  useHardwareKeyboardCommand,
  type HardwareKeyboardCommand,
} from "./hardwareKeyboardCommands";

const NO_JUMP_COMMANDS: readonly HardwareKeyboardCommand[] = [];

type ThreadShortcutListItem =
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more" }
  | { readonly type: "agent-thread"; readonly thread: EnvironmentThreadShell };

export function threadJumpIndex(command: HardwareKeyboardCommand) {
  return THREAD_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
}

/** Uses the rendered list so filters and shelves keep their order. */
export function threadJumpTarget(
  items: ReadonlyArray<ThreadShortcutListItem>,
  command: HardwareKeyboardCommand,
) {
  let index = threadJumpIndex(command);
  if (index < 0) return null;
  for (const item of items) {
    const thread =
      item.type === "v2-thread"
        ? item.item.thread
        : item.type === "agent-thread"
          ? item.thread
          : null;
    if (thread !== null && index-- === 0) return thread;
  }
  return null;
}

export function useThreadJumpShortcuts(
  items: ReadonlyArray<ThreadShortcutListItem>,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
  enabled = true,
) {
  const jumpToThread = useCallback(
    (command: HardwareKeyboardCommand) => {
      const thread = threadJumpTarget(items, command);
      if (thread !== null) onSelectThread(thread);
      return true;
    },
    [items, onSelectThread],
  );
  useHardwareKeyboardCommand(
    enabled ? THREAD_JUMP_KEYBINDING_COMMANDS : NO_JUMP_COMMANDS,
    jumpToThread,
  );
}
