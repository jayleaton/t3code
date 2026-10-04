import { AgentRunDragArea, SortableAgentThreads } from "./SortableAgentThreads";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useUiStateStore } from "../../uiStateStore";
import {
  isAgentChatInFocus,
  nestAgentRuns,
  selectAgentSidebarThreads,
  selectWorkingParentKeys,
  withAgentRunAncestors,
} from "./agents.logic";
import { useAgentThreadShells } from "./useAgentRunParenting";
import { ThreadCard } from "./ThreadCard";
import { useAgentThreadContextMenu } from "./useAgentThreadContextMenu";

export function AgentChatRail({ current }: { current: ScopedThreadRef }) {
  const allThreads = useAgentThreadShells();
  const threads = selectAgentSidebarThreads(allThreads);
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const currentKey = scopedThreadKey(current);
  const inFocus = sortActiveThreadsByOrderKey(
    threads.filter((thread) => {
      if (!thread.profileSnapshot) return false;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return isAgentChatInFocus(thread, visited[key], key === currentKey);
    }),
  );
  // A child in focus renders inside its parent's card, so the parent joins the rail.
  const { lists, childrenByKey } = nestAgentRuns({
    lists: {
      pinned: [],
      active: sortActiveThreadsByOrderKey(withAgentRunAncestors(inFocus, threads)),
      settled: [],
    },
    all: threads,
  });
  const workingKeys = selectWorkingParentKeys(allThreads);
  const visible = lists.active;
  const runByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const onContextMenu = useAgentThreadContextMenu(visible);
  return (
    <nav className="agent-chat-rail" aria-label="Active and unread agent chats">
      <div className="agent-chat-rail-label">Active & unread</div>
      <AgentRunDragArea active={visible}>
        <div className="agent-chat-rail-list">
          <SortableAgentThreads threads={visible}>
            {(thread, dragging) => (
              <ThreadCard
                thread={thread}
                dragging={dragging}
                childRuns={childrenByKey.get(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                )}
                workingKeys={workingKeys}
                childWorking={workingKeys.has(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                )}
                parentRun={
                  thread.parentThreadId == null
                    ? null
                    : runByKey.get(
                        scopedThreadKey(
                          scopeThreadRef(
                            thread.parentEnvironmentId ?? thread.environmentId,
                            thread.parentThreadId,
                          ),
                        ),
                      )
                }
                onContextMenu={onContextMenu}
              />
            )}
          </SortableAgentThreads>
        </div>
      </AgentRunDragArea>
    </nav>
  );
}
