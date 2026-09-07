import { useState, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { PreviewCard } from "@base-ui/react/preview-card";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProject } from "../../state/entities";
import { AgentChatPreview } from "./AgentChatPreview";
import { ThreadSpeedControl } from "./ThreadSpeedControl";
import { agentThreadStatus, agentThreadStatusLabel } from "./agents.logic";

export function ThreadCard({
  thread,
  onContextMenu,
}: {
  thread: EnvironmentThreadShell;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => Promise<void>;
}) {
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const status = agentThreadStatus(thread);
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <div className="agent-thread-container">
      <PreviewCard.Root
        open={!contextMenuOpen && previewOpen}
        onOpenChange={(open, details) => {
          if (
            !open &&
            details.reason === "trigger-hover" &&
            popupRef.current?.contains(document.activeElement)
          )
            return;
          setPreviewOpen(open);
        }}
      >
        <PreviewCard.Trigger
          onContextMenu={(event) => {
            event.preventDefault();
            setPreviewOpen(false);
            setContextMenuOpen(true);
            void onContextMenu(thread, { x: event.clientX, y: event.clientY }).finally(() => {
              setPreviewOpen(false);
              setContextMenuOpen(false);
            });
          }}
          delay={400}
          render={
            <Link
              to="/agents/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
            />
          }
          className={`agent-thread agent-thread-${status}`}
        >
          <div className="agent-thread-title">
            <strong>{thread.title}</strong>
            <span className={`agent-status agent-status-${status}`}>
              {agentThreadStatusLabel(status)}
            </span>
          </div>
          <div className="agent-thread-meta">
            <div className="agent-thread-location">
              <span className="agent-thread-project">
                {project?.title ?? "Project unavailable"}
              </span>
            </div>
          </div>
          <time className="agent-thread-time" dateTime={thread.updatedAt}>
            {new Date(thread.updatedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </PreviewCard.Trigger>
        <PreviewCard.Portal>
          <PreviewCard.Positioner side="right" align="start" sideOffset={12} className="z-[140]">
            <PreviewCard.Popup ref={popupRef} className="agent-chat-preview">
              {previewOpen && (
                <AgentChatPreview
                  thread={thread}
                  project={project?.title ?? "Project unavailable"}
                />
              )}
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
      <ThreadSpeedControl thread={thread} />
    </div>
  );
}
