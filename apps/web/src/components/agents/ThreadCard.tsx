import { GitPullRequestIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useState, useRef, useEffect, type CSSProperties } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { PreviewCard, PreviewCardTrigger, PreviewCardPopup } from "../ui/preview-card";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProject } from "../../state/entities";
import type { McpGatewayProfile } from "@t3tools/contracts";
import { AgentIcon } from "./AgentIcon";
import { useEnvironment } from "../../state/environments";
import { AgentChatPreview } from "./AgentChatPreview";
import { isInsideComposerFloatingLayer } from "../chat/composerEventScope";
import { agentThreadStatus, agentThreadStatusLabel } from "./agents.logic";
import {
  useLinkedThreadPullRequest,
  prStatusIndicator,
  linkedPullRequestSnapshotStatus,
} from "../ThreadStatusIndicators";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { useOpenPrLink } from "../../lib/openPullRequestLink";

export function ThreadCard({
  thread,
  profile,
  onContextMenu,
}: {
  profile?: McpGatewayProfile | undefined;
  thread: EnvironmentThreadShell;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => Promise<void>;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const environment = useEnvironment(thread.environmentId);
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const prReference = thread.linkedPullRequest ?? thread.branchPullRequest;
  const linkedPr = useLinkedThreadPullRequest(thread.environmentId, prReference);
  const prStatus = prStatusIndicator(linkedPr?.pr ?? null, linkedPr?.sourceControlProvider);
  const links = visibleThreadPullRequests(thread.pullRequests ?? []);
  const badges =
    links.length > 0
      ? links.map((link) => {
          const detail = linkedPullRequestSnapshotStatus(link);
          return {
            reference: link,
            status: prStatusIndicator(detail?.pr ?? null, detail?.sourceControlProvider),
          };
        })
      : [thread.linkedPullRequest, thread.branchPullRequest]
          .filter(
            (reference, index, references) =>
              reference != null &&
              references.findIndex((item) => item?.url === reference.url) === index,
          )
          .flatMap((reference) =>
            reference ? [{ reference, status: reference === prReference ? prStatus : null }] : [],
          );
  const openPrLink = useOpenPrLink();
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
    <div
      className="agent-thread-container"
      data-current={pathname === `/agents/${thread.environmentId}/${thread.id}`}
      style={{ "--agent-color": profile?.color ?? "var(--muted-foreground)" } as CSSProperties}
    >
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
            <div className="agent-thread-identity">
              {thread.profileSnapshot && (
                <span>
                  <AgentIcon icon={profile?.icon} />
                  <span>
                    {profile?.name ?? thread.profileSnapshot.profileName ?? "Removed agent"}
                  </span>
                </span>
              )}
              <span className={`agent-status agent-status-${status}`}>
                {agentThreadStatusLabel(status)}
              </span>
            </div>
          </div>
          <div className="agent-thread-meta">
            <span className="agent-thread-project">
              {project?.title ?? "Project unavailable"}
              {environment && <> · {environment.label}</>}
            </span>
            <time className="agent-thread-time" dateTime={thread.updatedAt}>
              {new Date(thread.updatedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
          </div>
          {environment?.connection.phase !== "connected" && (
            <p className="agent-thread-time">Environment unavailable</p>
          )}
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
      {badges.length > 0 && (
        <div className="agent-thread-prs" aria-label="Pull requests">
          {badges.map(({ reference, status }) => (
            <Tooltip key={reference.url}>
              <TooltipTrigger
                render={
                  <a
                    href={reference.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`agent-thread-pr ${status?.colorClass ?? "text-muted-foreground"}`}
                    aria-label={status?.tooltip ?? `Open PR #${reference.number}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) =>
                      openPrLink(event, reference.url, undefined, thread.environmentId)
                    }
                  />
                }
              >
                <GitPullRequestIcon size={12} aria-hidden="true" />
                <span className="agent-thread-pr-repository">{reference.repository}</span>
                <span>#{reference.number}</span>
              </TooltipTrigger>
              <TooltipPopup>
                {status?.tooltip ?? `${reference.repository} #${reference.number}`}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}
