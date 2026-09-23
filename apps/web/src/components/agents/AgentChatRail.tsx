import { SortableAgentThreads } from "./SortableAgentThreads";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { isAgentChatInFocus } from "./agents.logic";
import { ThreadCard } from "./ThreadCard";
import { useAgentThreadContextMenu } from "./useAgentThreadContextMenu";

export function AgentChatRail({ current }: { current: ScopedThreadRef }) {
  const threads = useThreadShells();
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const currentKey = scopedThreadKey(current);
  const visible = sortActiveThreadsByOrderKey(
    threads.filter((thread) => {
      if (!thread.profileSnapshot) return false;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return isAgentChatInFocus(thread, visited[key], key === currentKey);
    }),
  );
  const onContextMenu = useAgentThreadContextMenu(visible);
  return (
    <nav className="agent-chat-rail" aria-label="Active and unread agent chats">
      <div className="agent-chat-rail-label">Active & unread</div>
      <div className="agent-chat-rail-list">
        <SortableAgentThreads threads={visible}>
          {(thread, dragging) => (
            <ThreadCard thread={thread} dragging={dragging} onContextMenu={onContextMenu} />
          )}
        </SortableAgentThreads>
      </div>
    </nav>
  );
}
