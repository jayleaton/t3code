import { useState, useRef, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { PreviewCard, PreviewCardTrigger, PreviewCardPopup } from "../ui/preview-card";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProject } from "../../state/entities";
import { AgentChatPreview } from "./AgentChatPreview";
import { ThreadSpeedControl } from "./ThreadSpeedControl";
import { isInsideComposerFloatingLayer } from "../chat/composerEventScope";
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
  const editing = useRef(false);
  const closePreview = () => {
    editing.current = false;
    setPreviewOpen(false);
  };
  useEffect(() => {
    if (!previewOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        popupRef.current?.contains(event.target as Node) ||
        isInsideComposerFloatingLayer(event.target)
      )
        return;
      editing.current = false;
      setPreviewOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [previewOpen]);
  return (
    <div className="agent-thread-container">
      <PreviewCard
        open={!contextMenuOpen && previewOpen}
        onOpenChange={(open, details) => {
          if (
            !open &&
            details.reason === "trigger-hover" &&
            (editing.current ||
              popupRef.current?.contains(document.activeElement) ||
              isInsideComposerFloatingLayer(document.activeElement))
          )
            return;
          if (!open) editing.current = false;
          setPreviewOpen(open);
        }}
      >
        <PreviewCardTrigger
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
        </PreviewCardTrigger>
        <PreviewCardPopup
          ref={popupRef}
          onPointerDownCapture={() => {
            editing.current = true;
          }}
          onFocusCapture={() => {
            editing.current = true;
          }}
          side="right"
          align="start"
          sideOffset={12}
          // Composer menus and dialogs portal above this interactive preview.
          positionerClassName="z-[120]"
          className="agent-chat-preview bg-background text-foreground"
        >
          {previewOpen && (
            <AgentChatPreview
              thread={thread}
              project={project?.title ?? "Project unavailable"}
              onClose={closePreview}
            />
          )}
        </PreviewCardPopup>
      </PreviewCard>
      <ThreadSpeedControl thread={thread} />
    </div>
  );
}
