import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  agentParentOverrideApplied,
  applyAgentParentOverrides,
  type AgentParentOverride,
} from "./agents.logic";

interface PendingParent extends AgentParentOverride {
  /** The server accepted the change; the entry stays until the shell shows it. */
  readonly confirmed: boolean;
  /** Settles only its own entry, so a slow failure cannot undo a newer move. */
  readonly request: number;
}

// One board-wide store, so the board, the open-chat rail, and every drag
// surface show the same pending link.
let pending: ReadonlyMap<string, PendingParent> = new Map();
let requests = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const update = (change: (next: Map<string, PendingParent>) => void) => {
  const next = new Map(pending);
  change(next);
  pending = next;
  for (const listener of listeners) listener();
};

const keyOf = (thread: { environmentId: string; id: string }) =>
  `${thread.environmentId}:${thread.id}`;

/** Thread shells with pending parent changes applied (see applyAgentParentOverrides). */
export function useAgentThreadShells(): readonly EnvironmentThreadShell[] {
  const shells = useThreadShells();
  const overrides = useSyncExternalStore(subscribe, () => pending);
  useEffect(() => {
    const landed = shells.filter((thread) => {
      const override = overrides.get(keyOf(thread));
      return override?.confirmed && agentParentOverrideApplied(thread, override);
    });
    if (landed.length > 0) update((next) => landed.forEach((thread) => next.delete(keyOf(thread))));
  }, [shells, overrides]);
  return useMemo(() => applyAgentParentOverrides(shells, overrides), [shells, overrides]);
}

/**
 * Nests `child` under `parent`, re-parents it, or with `null` removes it from
 * its parent. The board shows the change at once; a rejected or failed command
 * rolls it back to the server's link and says why. Agents make the same change
 * through t3_set_thread_parent, which dispatches the same command.
 */
export function useSetAgentRunParent() {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return useCallback(
    async (child: EnvironmentThreadShell, parent: EnvironmentThreadShell | null) => {
      const key = keyOf(child);
      const parentEnvironmentId =
        parent && parent.environmentId !== child.environmentId ? parent.environmentId : null;
      const request = (requests += 1);
      update((next) =>
        next.set(key, {
          parentThreadId: parent?.id ?? null,
          parentEnvironmentId,
          confirmed: false,
          request,
        }),
      );
      const result = await updateThreadMetadata({
        environmentId: child.environmentId,
        input: {
          threadId: child.id,
          parentThreadId: parent?.id ?? null,
          ...(parentEnvironmentId === null ? {} : { parentEnvironmentId }),
        },
      });
      if (result._tag === "Failure") {
        update((next) => {
          if (next.get(key)?.request === request) next.delete(key);
        });
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            title: parent ? `Couldn't move under ${parent.title}` : "Couldn't remove from parent",
            description: error instanceof Error ? error.message : "Try again.",
            type: "error",
          }),
        );
        return false;
      }
      update((next) => {
        const entry = next.get(key);
        if (entry?.request === request) next.set(key, { ...entry, confirmed: true });
      });
      return true;
    },
    [updateThreadMetadata],
  );
}
