import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import {
  readEnvironmentSupportsActiveReorder,
  useThreadShells,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
  useProjects,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useUiStateStore } from "../../uiStateStore";
import { useClientSettings } from "../../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../ui/toast";

import { planAgentThreadMove } from "./agents.logic";

type AgentThreadMenuId =
  | "move-up"
  | "move-down"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "regenerate-title"
  | "mark-unread"
  | "detach-parent"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      title,
      description: error instanceof Error ? error.message : "Try again.",
      type: "error",
    }),
  );
}

/**
 * The Agents workspace's per-chat menu. It is invoked once at the board level
 * (not per card) so a board with many chat cards does not subscribe each card
 * to projects, settings, and the thread action commands.
 */
export function useAgentThreadContextMenu(visible: readonly EnvironmentThreadShell[]) {
  const threads = useThreadShells();
  const router = useRouter();
  const projects = useProjects();
  const {
    reorderActiveThread,
    settleThread,
    unsettleThread,
    pinThread,
    confirmAndUnpinThread,
    confirmAndDeleteThread,
    archiveThread,
  } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: string }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Chat ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy chat ID", error),
  });

  return useCallback(
    async (thread: EnvironmentThreadShell, position: { x: number; y: number }) => {
      const api = readLocalApi();
      const ref = scopeThreadRef(thread.environmentId, thread.id);
      const current = readThreadShell(ref);
      if (!api || !current) return;
      const settled = current.settledAt !== null;
      const pinned = current.pinnedAt != null;
      const supportsPinning = readEnvironmentSupportsPinning(ref.environmentId);
      const supportsSettlement = readEnvironmentSupportsSettlement(ref.environmentId);
      const supportsTitleRegeneration = readEnvironmentSupportsTitleRegeneration(ref.environmentId);
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === current.environmentId && candidate.id === current.projectId,
      );
      const workspacePath = current.worktreePath ?? project?.workspaceRoot ?? null;
      const planMove = (direction: "up" | "down") => {
        const refresh = (items: readonly EnvironmentThreadShell[]) =>
          items.flatMap((item) => {
            const shell = readThreadShell(scopeThreadRef(item.environmentId, item.id));
            return shell ? [shell] : [];
          });
        const plan = planAgentThreadMove(refresh(visible), refresh(threads), current, direction);
        return plan?.every(({ thread }) =>
          readEnvironmentSupportsActiveReorder(thread.environmentId),
        )
          ? plan
          : null;
      };
      const items: ContextMenuItem<AgentThreadMenuId>[] = [
        ...(supportsPinning
          ? [
              pinned
                ? { id: "unpin" as const, label: "Unpin chat", icon: "pin-off" }
                : { id: "pin" as const, label: "Pin chat to top", icon: "pin" },
            ]
          : []),
        ...(!pinned && !settled
          ? [
              {
                id: "move-up" as const,
                label: "Move up",
                icon: "arrow-up",
                disabled: !planMove("up"),
              },
              {
                id: "move-down" as const,
                label: "Move down",
                icon: "arrow-down",
                disabled: !planMove("down"),
              },
            ]
          : []),
        ...(supportsSettlement
          ? [
              {
                id: (settled ? "unsettle" : "settle") as "settle" | "unsettle",
                label: settled ? "Un-settle chat" : "Settle chat",
                icon: "circle-check",
              },
            ]
          : []),
        ...(supportsTitleRegeneration
          ? [
              {
                id: "regenerate-title" as const,
                label: current.titleRegeneration != null ? "Regenerating…" : "Regenerate title",
                icon: "refresh-cw",
                disabled: current.titleRegeneration != null,
              },
            ]
          : []),
        { id: "mark-unread", label: "Mark unread", icon: "mail-open", separatorBefore: true },
        ...(current.parentThreadId != null
          ? [{ id: "detach-parent" as const, label: "Detach from parent run", icon: "unlink" }]
          : []),
        {
          id: "copy-path",
          label: "Copy path",
          icon: "folder",
          disabled: workspacePath === null,
        },
        ...(current.branch
          ? [{ id: "copy-branch" as const, label: "Copy branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Copy chat ID", icon: "hash" },
        { id: "archive", label: "Archive chat", icon: "archive", separatorBefore: true },
        { id: "delete", label: "Delete", destructive: true, icon: "trash" },
      ];
      let action: AgentThreadMenuId | null;
      try {
        action = await api.contextMenu.show(items, position);
      } catch (error) {
        failureToast("Could not open the chat menu", error);
        return;
      }
      if (!action) return;

      const reportFailure = async (
        title: string,
        run: () => Promise<AtomCommandResult<unknown, unknown>>,
      ) => {
        const result = await run();
        if (result._tag === "Failure") {
          failureToast(title, squashAtomCommandFailure(result));
        }
      };

      switch (action) {
        case "move-up":
        case "move-down": {
          const plan = planMove(action === "move-up" ? "up" : "down");
          if (!plan) return;
          for (const { thread: target, orderKey } of plan) {
            const result = await reorderActiveThread(
              scopeThreadRef(target.environmentId, target.id),
              orderKey,
            );
            if (result._tag === "Failure") {
              failureToast("Failed to move chat", squashAtomCommandFailure(result));
              return;
            }
          }
          return;
        }
        case "pin":
          await reportFailure("Failed to pin chat", () => pinThread(ref));
          return;
        case "unpin":
          await reportFailure("Failed to unpin chat", () => confirmAndUnpinThread(ref));
          return;
        case "settle":
          await reportFailure("Failed to settle chat", () => settleThread(ref));
          return;
        case "unsettle":
          await reportFailure("Failed to un-settle chat", () => unsettleThread(ref));
          return;
        case "regenerate-title":
          await reportFailure("Failed to regenerate chat title", () =>
            updateThreadMetadata({
              environmentId: ref.environmentId,
              input: { threadId: ref.threadId, regenerateTitle: true },
            }),
          );
          return;
        case "mark-unread":
          markThreadUnread(scopedThreadKey(ref), current.latestTurn?.completedAt);
          return;
        case "detach-parent":
          await reportFailure("Failed to detach chat", () =>
            updateThreadMetadata({
              environmentId: ref.environmentId,
              input: { threadId: ref.threadId, parentThreadId: null },
            }),
          );
          return;
        case "copy-path":
          if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
          return;
        case "copy-branch":
          if (current.branch) copyBranchToClipboard(current.branch, { branch: current.branch });
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(ref.threadId, { threadId: ref.threadId });
          return;
        case "archive": {
          if (confirmThreadArchive) {
            const confirmed = await api.dialogs.confirm(`Archive chat "${current.title}"?`);
            if (!confirmed) return;
          }
          await reportFailure("Failed to archive chat", () =>
            archiveThread(ref, {
              onArchived: () => {
                void router.navigate({ to: "/agents" });
              },
            }),
          );
          return;
        }
        case "delete":
          await reportFailure("Failed to delete chat", () => confirmAndDeleteThread(ref));
          return;
      }
    },
    [
      visible,
      threads,
      reorderActiveThread,
      archiveThread,
      confirmAndDeleteThread,
      confirmAndUnpinThread,
      confirmThreadArchive,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      markThreadUnread,
      pinThread,
      projects,
      router,
      settleThread,
      unsettleThread,
      updateThreadMetadata,
    ],
  );
}
