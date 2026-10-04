import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";

import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import {
  applyPendingParents,
  parentLinkKey,
  parentRejection,
  pendingParentSettled,
  type PendingParent,
} from "./agent-parenting";

/**
 * Set, change, or clear a chat's parent. The board shows the move at once and
 * falls back to the server's state if the command fails, so a rejected move
 * never leaves a half-linked card behind.
 */
export function useThreadParentActions(threads: readonly EnvironmentThreadShell[]) {
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<ReadonlyMap<string, PendingParent>>(new Map());
  const withoutPending = useCallback((key: string) => {
    setPending((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  // Overrides retire once the synced shells carry the same parent.
  useEffect(() => {
    if (pending.size === 0) return;
    for (const thread of threads) {
      const override = pending.get(parentLinkKey(thread));
      if (override && pendingParentSettled(thread, override)) withoutPending(parentLinkKey(thread));
    }
  }, [threads, pending, withoutPending]);

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
      setPending((current) =>
        new Map(current).set(key, {
          parentThreadId: parent?.id ?? null,
          parentEnvironmentId,
        }),
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const result = await updateThreadMetadata({
        environmentId: child.environmentId,
        input: {
          threadId: child.id,
          parentThreadId: parent?.id ?? null,
          ...(parentEnvironmentId ? { parentEnvironmentId } : {}),
        },
      });
      if (result._tag === "Failure") {
        withoutPending(key);
        const error = Cause.squash(result.cause);
        Alert.alert(
          parent ? "Could not move chat" : "Could not remove from parent",
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The chat was left where it was.",
        );
        return false;
      }
      return true;
    },
    [threads, updateThreadMetadata, withoutPending],
  );

  const displayed = useMemo(() => applyPendingParents(threads, pending), [threads, pending]);
  return { threads: displayed, setParent };
}
