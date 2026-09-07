import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AgentIcon, agentColors } from "./AgentIcon";
import { PreviewCard } from "@base-ui/react/preview-card";
import { AgentChatPreview } from "./AgentChatPreview";
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type CSSProperties } from "react";
import {
  PlusIcon,
  MoreHorizontalIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  SettingsIcon,
  PencilIcon,
  Trash2Icon,
  SquarePenIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { useEnvironments } from "../../state/environments";
import {
  useThreadShells,
  useAllEnvironmentShellsBootstrapped,
  useProject,
  readThreadShell,
  readEnvironmentSupportsSettlement,
} from "../../state/entities";
import { AgentEditor } from "./AgentEditor";
import { AgentTaskDialog } from "./AgentTaskDialog";
import { agentThreadStatus, groupAgentThreads } from "./agents.logic";
import { SidebarMenuButton } from "../ui/sidebar";
import { openCommandPalette } from "../../commandPaletteBus";
import { searchSidebarThreadsByTitle } from "../Sidebar.logic";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

const agentOrderSchema = Schema.Array(Schema.String);
const emptyAgentOrder: readonly string[] = [];

function ThreadCard({
  thread,
  profile,
  onContextMenu,
}: {
  thread: EnvironmentThreadShell;
  profile?: McpGatewayProfile | undefined;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => Promise<void>;
}) {
  const project = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const [previewOpen, setPreviewOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const status = agentThreadStatus(thread);
  const snapshot = thread.profileSnapshot;
  const old = profile && snapshot && snapshot.revision !== profile.revision;
  return (
    <PreviewCard.Root open={!contextMenuOpen && previewOpen} onOpenChange={setPreviewOpen}>
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
          <span className={`agent-status agent-status-${status}`}>{status}</span>
        </div>
        <div className="agent-thread-meta">
          <div className="agent-thread-location">
            <span className="agent-thread-project">{project?.title ?? "Project unavailable"}</span>
          </div>
          <span>
            {thread.session?.status === "error"
              ? "Needs attention"
              : new Date(thread.updatedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
          </span>
        </div>
        {old && (
          <span className="agent-old-model">
            Started with {thread.modelSelection.model} · v{snapshot.revision}
          </span>
        )}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="right" align="start" sideOffset={12} className="z-[140]">
          <PreviewCard.Popup className="agent-chat-preview">
            {previewOpen && (
              <AgentChatPreview thread={thread} project={project?.title ?? "Project unavailable"} />
            )}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

function AgentThreadList({
  threads,
  profile,
  onContextMenu,
}: {
  threads: readonly EnvironmentThreadShell[];
  profile?: McpGatewayProfile | undefined;
  onContextMenu: (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => Promise<void>;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const active = threads.filter((thread) => thread.settledAt === null);
  const settled = threads.filter((thread) => thread.settledAt !== null);
  const renderCard = (thread: EnvironmentThreadShell) => (
    <ThreadCard
      key={`${thread.environmentId}:${thread.id}`}
      thread={thread}
      profile={profile}
      onContextMenu={onContextMenu}
    />
  );
  return (
    <div className="agent-thread-list">
      {active.map(renderCard)}
      {threads.length === 0 && (
        <p className="agent-empty">
          Ready when you are.
          <br />
          Start a new chat.
        </p>
      )}
      {settled.length > 0 && (
        <details
          className="agent-settled"
          open={settledOpen}
          onToggle={(event) => setSettledOpen(event.currentTarget.open)}
        >
          <summary>Settled · {settled.length}</summary>
          {settledOpen && <div className="agent-thread-list">{settled.map(renderCard)}</div>}
        </details>
      )}
    </div>
  );
}

export function AgentsBoard() {
  const { settleThread, unsettleThread } = useThreadActions();
  const onThreadContextMenu = async (
    thread: EnvironmentThreadShell,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const current = readThreadShell(ref);
    if (!api || !current) return;
    const settled = current.settledAt !== null;
    try {
      const action = await api.contextMenu.show(
        [
          {
            id: settled ? "unsettle" : "settle",
            label: settled ? "Un-settle chat" : "Settle chat",
            icon: settled ? "circle" : "circle-check",
            disabled: !readEnvironmentSupportsSettlement(thread.environmentId),
          },
        ],
        position,
      );
      if (!action) return;
      const result = await (action === "settle" ? settleThread(ref) : unsettleThread(ref));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        throw squashAtomCommandFailure(result);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: settled ? "Could not un-settle chat" : "Could not settle chat",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  };
  const { profiles, available, updateSettings } = useAgentLibrary();
  const [order, setOrder] = useLocalStorage(
    "t3code:agents:column-order",
    emptyAgentOrder,
    agentOrderSchema,
  );
  const orderedProfiles = useMemo(() => {
    const ranks = new Map(order.map((id, index) => [id, index]));
    return profiles.toSorted(
      (a, b) => (ranks.get(a.profileId) ?? order.length) - (ranks.get(b.profileId) ?? order.length),
    );
  }, [profiles, order]);
  const moveAgent = (index: number, direction: -1 | 1) => {
    const ids = orderedProfiles.map((profile) => profile.profileId);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setOrder(ids);
  };
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const [editor, setEditor] = useState<McpGatewayProfile | "new" | null>(null);
  const [task, setTask] = useState<McpGatewayProfile | null>(null);
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const results = useMemo(() => searchSidebarThreadsByTitle(threads, query), [threads, query]);
  const [deleting, setDeleting] = useState<McpGatewayProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const { groups, orphaned } = useMemo(
    () => groupAgentThreads(profiles, threads),
    [profiles, threads],
  );
  const online = environments.filter((env) => env.connection.phase === "connected");
  return (
    <div className="agents-page">
      <header className="agents-topbar">
        <Link to="/" className="agents-brand">
          <strong>T3</strong>
          <span>/ agents</span>
        </Link>
        <nav aria-label="Workspace view">
          <span aria-current="page">Agents</span>
          <Link to="/">Threads</Link>
        </nav>
        <div className="agents-search">
          <SearchIcon size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search all chats"
            placeholder="Search all chats…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
          {query && (
            <button aria-label="Clear chat search" onClick={() => setQuery("")}>
              <XIcon size={14} />
            </button>
          )}
        </div>
        <div className="agents-topbar-actions">
          <button
            className="agent-icon-button"
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <PlusIcon size={14} /> Add project
          </button>
          <Link to="/settings" aria-label="Settings" className="agent-icon-button">
            <SettingsIcon size={15} />
          </Link>
          <button className="agent-primary" disabled={!available} onClick={() => setEditor("new")}>
            <PlusIcon size={14} />
            Agent
          </button>
        </div>
      </header>
      {!available && (
        <p role="status" className="agents-notice">
          Connect an environment with agent sync support to create or edit agents.
        </p>
      )}
      {!ready && (
        <p role="status" className="agents-notice">
          Loading connected environments…
        </p>
      )}
      {searching ? (
        <main className="agents-search-results" aria-label="Chat search results">
          <p role="status">
            {results.length} {results.length === 1 ? "chat" : "chats"} found across all projects
          </p>
          {results.map((thread) => (
            <ThreadCard
              key={`${thread.environmentId}:${thread.id}`}
              onContextMenu={onThreadContextMenu}
              thread={thread}
            />
          ))}
        </main>
      ) : (
        <>
          <main className="agents-board" aria-label="Agents board">
            {orderedProfiles.map((profile, index) => (
              <section
                key={profile.profileId}
                className="agent-column"
                style={
                  {
                    "--agent-color":
                      profile.color ??
                      agentColors[
                        profiles.findIndex((item) => item.profileId === profile.profileId) %
                          agentColors.length
                      ],
                  } as CSSProperties
                }
                aria-label={`${profile.name} agent`}
              >
                <div className="agent-column-header">
                  <div className="agent-heading">
                    <AgentIcon icon={profile.icon} />
                    <h2>{profile.name}</h2>

                    <SidebarMenuButton
                      size="icon"
                      type="button"
                      aria-label={`New chat with ${profile.name}`}
                      tooltip="New chat"
                      disabled={profile.runtimeMode === "read-only"}
                      onClick={() => setTask(profile)}
                    >
                      <SquarePenIcon />
                    </SidebarMenuButton>
                    <Menu>
                      <MenuTrigger
                        className="agent-icon-button"
                        aria-label={`Options for ${profile.name}`}
                      >
                        <MoreHorizontalIcon size={14} />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem disabled={!available} onClick={() => setEditor(profile)}>
                          <PencilIcon />
                          Edit agent
                        </MenuItem>
                        <MenuItem disabled={index === 0} onClick={() => moveAgent(index, -1)}>
                          <ArrowLeftIcon />
                          Move left
                        </MenuItem>
                        <MenuItem
                          disabled={index === orderedProfiles.length - 1}
                          onClick={() => moveAgent(index, 1)}
                        >
                          <ArrowRightIcon />
                          Move right
                        </MenuItem>
                        <MenuItem
                          disabled={!available}
                          onClick={() => {
                            setDeleting(profile);
                            setDeleteError("");
                          }}
                        >
                          <Trash2Icon />
                          Delete agent
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                  <div className="agent-chips">
                    <span className="agent-provider">
                      {profile.providerLabel ??
                        profile.modelSelection?.instanceId ??
                        "Select provider"}
                    </span>
                    <span>
                      {profile.modelLabel ?? profile.modelSelection?.model ?? "Select model"}
                    </span>
                    <span>thinking {profile.reasoningEffort ?? "default"}</span>
                  </div>

                  {profile.runtimeMode === "read-only" && (
                    <p className="text-xs text-muted-foreground">
                      Read-only profiles cannot start threads.
                    </p>
                  )}
                </div>
                <AgentThreadList
                  threads={groups.get(profile.profileId) ?? []}
                  profile={profile}
                  onContextMenu={onThreadContextMenu}
                />
              </section>
            ))}
            <button
              className="agent-new-column"
              disabled={!available}
              onClick={() => setEditor("new")}
            >
              <span className="agent-new-icon">
                <PlusIcon />
              </span>
              <strong>New agent</strong>
              <span>
                Name a specialist. Pin provider,
                <br />
                model, and thinking.
                <br />
                Give it a task when you’re ready.
              </span>
            </button>
          </main>
          {orphaned.length > 0 && (
            <details className="agents-removed">
              <summary>Removed agents · {orphaned.length} chats</summary>
              <AgentThreadList threads={orphaned} onContextMenu={onThreadContextMenu} />
            </details>
          )}
        </>
      )}
      {editor !== null && (
        <AgentEditor
          profile={editor === "new" ? null : editor}
          profiles={profiles}
          providers={online.flatMap((env) => env.serverConfig?.providers ?? [])}
          machines={environments}
          onClose={() => setEditor(null)}
          onSave={(profile) =>
            updateSettings({
              mcpGatewayProfiles:
                editor === "new"
                  ? [...profiles, profile]
                  : profiles.map((item) => (item.profileId === profile.profileId ? profile : item)),
            })
          }
        />
      )}
      {task && <AgentTaskDialog profile={task} onClose={() => setTask(null)} />}
      {deleting && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setDeleting(null);
          }}
        >
          <DialogPopup className="agent-dialog p-6">
            <DialogTitle>Delete {deleting.name}?</DialogTitle>
            <DialogDescription className="mt-2 text-sm text-muted-foreground">
              Existing threads will remain under Removed agents. This does not stop running work.
            </DialogDescription>
            {deleteError && <p role="alert">{deleteError}</p>}
            <div className="agent-form">
              <footer>
                <button disabled={busy} onClick={() => setDeleting(null)}>
                  Cancel
                </button>
                <button
                  className="agent-primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      if (
                        await updateSettings({
                          mcpGatewayProfiles: profiles.filter(
                            (p) => p.profileId !== deleting.profileId,
                          ),
                        })
                      )
                        setDeleting(null);
                      else setDeleteError("Could not delete the agent. Try again.");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Deleting…" : "Delete agent"}
                </button>
              </footer>
            </div>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
