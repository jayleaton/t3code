import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTime } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { CornerLeftUpIcon, PinIcon } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  useContext,
  useState,
  useRef,
  useEffect,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useDraggable } from "@dnd-kit/core";
import { AgentRunDragContext, agentChildDragId } from "./agentRunDrag";
import { Link, useLocation } from "@tanstack/react-router";
import { PreviewCard, PreviewCardTrigger, PreviewCardPopup } from "../ui/preview-card";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useProject } from "../../state/entities";
import { resolveEnvironmentMachineKind, type McpGatewayProfile } from "@t3tools/contracts";
import { AgentIcon } from "./AgentIcon";
import { useEnvironment } from "../../state/environments";
import { AgentChatPreview } from "./AgentChatPreview";
import { isInsideComposerFloatingLayer } from "../chat/composerEventScope";
import { agentThreadStatus, agentThreadStatusLabel, type AgentChildRun } from "./agents.logic";
import {
  useLinkedThreadPullRequest,
  prStatusIndicator,
  linkedPullRequestSnapshotStatus,
} from "../ThreadStatusIndicators";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { useOpenPrLink } from "../../lib/openPullRequestLink";

function runAgentName(
  run: EnvironmentThreadShell,
  profiles: readonly McpGatewayProfile[] | undefined,
) {
  const profile = profiles?.find(
    (candidate) => candidate.profileId === run.profileSnapshot?.profileId,
  );
  return {
    profile,
    name: profile?.name ?? run.profileSnapshot?.profileName ?? "Chat",
  };
}

function AgentChildRunLink({
  run,
  depth,
  profiles,
  onPointerDown,
}: {
  run: EnvironmentThreadShell;
  depth: number;
  profiles: readonly McpGatewayProfile[] | undefined;
  onPointerDown?: (event: ReactPointerEvent<HTMLAnchorElement>) => void;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const status = agentThreadStatus(run);
  const agent = runAgentName(run, profiles);
  return (
    <Link
      to="/agents/$environmentId/$threadId"
      params={{ environmentId: run.environmentId, threadId: run.id }}
      className="agent-thread-child"
      data-current={pathname === `/agents/${run.environmentId}/${run.id}`}
      style={
        {
          "--agent-color": agent.profile?.color ?? "var(--muted-foreground)",
          paddingInlineStart: `${6 + depth * 12}px`,
        } as CSSProperties
      }
      {...(onPointerDown ? { onPointerDown } : {})}
    >
      <AgentIcon icon={agent.profile?.icon} />
      <span className="agent-thread-child-agent">{agent.name}</span>
      <span className="agent-thread-child-title">{run.title}</span>
      <span className={`agent-status agent-status-${status}`}>
        {agentThreadStatusLabel(status)}
      </span>
    </Link>
  );
}

/** A sub-run row that can be dragged onto another card or out of this one. */
function DraggableAgentChildRun(props: {
  run: EnvironmentThreadShell;
  depth: number;
  anchorKey: string;
  profiles: readonly McpGatewayProfile[] | undefined;
}) {
  const key = `${props.run.environmentId}:${props.run.id}`;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: agentChildDragId(key),
    data: { anchorKey: props.anchorKey },
  });
  return (
    <li ref={setNodeRef} data-dragging={isDragging || undefined}>
      <AgentChildRunLink
        {...props}
        // The row starts its own drag, not the card's.
        onPointerDown={(event) => {
          listeners?.onPointerDown?.(event);
          event.stopPropagation();
        }}
      />
    </li>
  );
}

/** Runs this card's run created, each linking to its own chat with live status. */
function AgentChildRuns({
  runs,
  anchorKey,
  profiles,
}: {
  runs: readonly AgentChildRun<EnvironmentThreadShell>[];
  anchorKey: string;
  profiles: readonly McpGatewayProfile[] | undefined;
}) {
  const { childDragEnabled } = useContext(AgentRunDragContext);
  return (
    <ul className="agent-thread-children" aria-label="Sub-agent runs">
      {runs.map(({ thread: run, depth }) =>
        childDragEnabled ? (
          <DraggableAgentChildRun
            key={`${run.environmentId}:${run.id}`}
            run={run}
            depth={depth}
            anchorKey={anchorKey}
            profiles={profiles}
          />
        ) : (
          <li key={`${run.environmentId}:${run.id}`}>
            <AgentChildRunLink run={run} depth={depth} profiles={profiles} />
          </li>
        ),
      )}
    </ul>
  );
}

export function ThreadCard({
  thread,
  profile,
  profiles,
  childRuns,
  parentRun,
  dragging = false,
  onContextMenu,
}: {
  profile?: McpGatewayProfile | undefined;
  /** Resolves the agents of related runs; falls back to their snapshot names. */
  profiles?: readonly McpGatewayProfile[] | undefined;
  /** Runs folded into this card by nestAgentRuns. */
  childRuns?: readonly AgentChildRun<EnvironmentThreadShell>[] | undefined;
  /** The run that created this one, when this card stands on its own. */
  parentRun?: EnvironmentThreadShell | null | undefined;
  dragging?: boolean;
  thread: EnvironmentThreadShell;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => Promise<void>;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { nestTargetKey } = useContext(AgentRunDragContext);
  const environment = useEnvironment(thread.environmentId);
  useNowMinute();
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  const relativeTime = formatRelativeTime(timestamp)?.value;
  const provider = environment?.serverConfig?.providers.find(
    (candidate) => candidate.instanceId === thread.modelSelection.instanceId,
  );
  const ModelProviderIcon = provider ? PROVIDER_ICON_BY_PROVIDER[provider.driver] : undefined;
  const model = provider?.models.find(
    (candidate) => candidate.slug === thread.modelSelection.model,
  );
  const modelLabel = model?.name ?? thread.modelSelection.model;
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
      data-nest-target={nestTargetKey === `${thread.environmentId}:${thread.id}` || undefined}
      style={{ "--agent-color": profile?.color ?? "var(--muted-foreground)" } as CSSProperties}
    >
      <PreviewCard
        open={!dragging && !contextMenuOpen && previewOpen}
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
          setPreviewOpen(open && !dragging);
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
            <strong>
              {thread.pinnedAt != null && (
                <PinIcon aria-label="Pinned" className="agent-thread-pin" size={11} />
              )}
              {thread.title}
            </strong>
            <Tooltip>
              <TooltipTrigger render={<time className="agent-thread-time" dateTime={timestamp} />}>
                {relativeTime === "just now" ? "now" : relativeTime}
              </TooltipTrigger>
              <TooltipPopup>{new Date(timestamp).toLocaleString()}</TooltipPopup>
            </Tooltip>
          </div>
          <div className="agent-thread-meta">
            <span className="agent-thread-project">
              <EnvironmentMachineIcon
                kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                className="mr-1 inline-block size-3.5 align-[-2px]"
                aria-hidden="true"
              />
              {environment?.label ?? "Machine unavailable"}/
              {project?.title ?? "Project unavailable"}
            </span>
          </div>
          <div className="agent-thread-footer">
            <div className="agent-thread-identity">
              {thread.profileSnapshot && (
                <span>
                  <AgentIcon icon={profile?.icon} />
                  <span>
                    {profile?.name ?? thread.profileSnapshot.profileName ?? "Removed agent"}
                  </span>
                </span>
              )}
              {ModelProviderIcon && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="agent-thread-model" aria-label={`Model: ${modelLabel}`} />
                    }
                  >
                    <ModelProviderIcon className="size-3.5" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipPopup>{modelLabel}</TooltipPopup>
                </Tooltip>
              )}
            </div>
            <span className={`agent-status agent-status-${status}`}>
              {agentThreadStatusLabel(status)}
            </span>
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
      {parentRun && (
        <div className="agent-thread-prs">
          <Link
            to="/agents/$environmentId/$threadId"
            params={{ environmentId: parentRun.environmentId, threadId: parentRun.id }}
            className="agent-thread-pr agent-thread-parent"
            aria-label={`Created by ${runAgentName(parentRun, profiles).name}: ${parentRun.title}`}
          >
            <CornerLeftUpIcon size={12} aria-hidden="true" />
            <span className="agent-thread-pr-repository">
              {runAgentName(parentRun, profiles).name} · {parentRun.title}
            </span>
          </Link>
        </div>
      )}
      {childRuns && childRuns.length > 0 && (
        <AgentChildRuns
          runs={childRuns}
          anchorKey={`${thread.environmentId}:${thread.id}`}
          profiles={profiles}
        />
      )}
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
                <PullRequestGlyph.pullRequest size={12} aria-hidden="true" />
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
