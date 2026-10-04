import {
  agentParentOverrideApplied,
  applyAgentParentOverrides,
  type AgentParentOverride,
} from "@t3tools/client-runtime/state/agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { parentLinkKey, parentRejection } from "./agent-parenting";

interface PendingParent extends AgentParentOverride {
  /** The server accepted the change; the entry stays until the shell shows it. */
  readonly confirmed: boolean;
  /** Settles only its own entry, so a slow failure cannot undo a newer move. */
  readonly request: number;
}

/**
 * Set, change, or clear a chat's parent through the same metadata command web
 * and t3_set_thread_parent use. The board shows the move at once and falls
 * back to the server's link if the command fails, so a rejected move never
 * leaves a half-linked card behind.
 */
export function useThreadParentActions(threads: readonly EnvironmentThreadShell[]) {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<ReadonlyMap<string, PendingParent>>(new Map());
  const requests = useRef(0);
  const change = useCallback((edit: (next: Map<string, PendingParent>) => void) => {
    setPending((current) => {
      const next = new Map(current);
      edit(next);
      return next;
    });
  }, []);

  // Confirmed overrides retire once the synced shells carry the same parent.
  useEffect(() => {
    const landed = threads.filter((thread) => {
      const override = pending.get(parentLinkKey(thread));
      return override?.confirmed && agentParentOverrideApplied(thread, override);
    });
    if (landed.length > 0) {
      change((next) => landed.forEach((thread) => next.delete(parentLinkKey(thread))));
    }
  }, [threads, pending, change]);

  const setParent = useCallback(
    async (child: EnvironmentThreadShell, parent: EnvironmentThreadShell | null) => {
      if (parent) {
        const rejection = parentRejection(child, parent, threads);
        if (rejection) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Alert.alert("Can't move chat", rejection);
          return false;
        }
      }
      const key = parentLinkKey(child);
      const parentEnvironmentId =
        parent && parent.environmentId !== child.environmentId ? parent.environmentId : null;
      const request = (requests.current += 1);
      change((next) =>
        next.set(key, {
          parentThreadId: parent?.id ?? null,
          parentEnvironmentId,
          confirmed: false,
          request,
        }),
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const result = await updateThreadMetadata({
        environmentId: child.environmentId,
        input: {
          threadId: child.id,
          parentThreadId: parent?.id ?? null,
          ...(parentEnvironmentId === null ? {} : { parentEnvironmentId }),
        },
      });
      if (result._tag === "Failure") {
        change((next) => {
          if (next.get(key)?.request === request) next.delete(key);
        });
        const error = Cause.squash(result.cause);
        Alert.alert(
          parent ? `Couldn't move under ${parent.title}` : "Couldn't remove from parent",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The chat was left where it was.",
        );
        return false;
      }
      change((next) => {
        const entry = next.get(key);
        if (entry?.request === request) next.set(key, { ...entry, confirmed: true });
      });
      return true;
    },
    [threads, updateThreadMetadata, change],
  );

  const displayed = useMemo(() => applyAgentParentOverrides(threads, pending), [threads, pending]);
  return { threads: displayed, setParent };
}
