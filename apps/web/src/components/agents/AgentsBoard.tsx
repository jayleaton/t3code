import { useClientSettings } from "../../hooks/useSettings";
import { visibleAgentProviders } from "./agentModelCatalog";
import { ThreadCard } from "./ThreadCard";
import { useAgentThreadContextMenu } from "./useAgentThreadContextMenu";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { AgentIcon, agentColors } from "./AgentIcon";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useMemo, useState, type CSSProperties } from "react";
import {
  PlusIcon,
  MoreHorizontalIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  SettingsIcon,
  PencilIcon,
  Trash2Icon,
  SearchIcon,
  XIcon,
  LayoutGridIcon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { useEnvironments } from "../../state/environments";
import { useThreadShells, useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { AgentEditor } from "./AgentEditor";
import { AgentTaskDialog } from "./AgentTaskDialog";
import { AgentsLoadingNotice } from "./AgentsLoadingNotice";
import { groupAgentThreads, selectAgentWorkspaceThreads } from "./agents.logic";
import { DesktopUpdateButton } from "../sidebar/SidebarUpdatePill";
import { BrandMark } from "../BrandMark";
import { openCommandPalette } from "../../commandPaletteBus";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

const agentFilterSchema = Schema.NullOr(Schema.String);
const agentOrderSchema = Schema.Array(Schema.String);
const emptyAgentOrder: readonly string[] = [];

function AgentThreadList({
  threads,
  onContextMenu,
  profiles,
}: {
  profiles: readonly McpGatewayProfile[];
  threads: readonly EnvironmentThreadShell[];
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
      profile={profiles.find((profile) => profile.profileId === thread.profileSnapshot?.profileId)}
      onContextMenu={onContextMenu}
    />
  );
  return (
    <div className="agent-thread-list">
      {active.map(renderCard)}
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
  const onThreadContextMenu = useAgentThreadContextMenu();
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
  const modelPreferences = useClientSettings((settings) => settings.providerModelPreferences);
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const [editor, setEditor] = useState<McpGatewayProfile | "new" | null>(null);
  const [task, setTask] = useState<McpGatewayProfile | null>(null);
  const [query, setQuery] = useState("");
  const [savedFilter, setFilter] = useLocalStorage("t3code:agents:filter", null, agentFilterSchema);
  const filter = profiles.some((profile) => profile.profileId === savedFilter) ? savedFilter : null;
  const [showFilters, setShowFilters] = useState(false);
  const selected = useLocation({
    select: (location) => location.pathname.split("/").filter(Boolean).length > 1,
  });
  const [deleting, setDeleting] = useState<McpGatewayProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const { groups, orphaned } = useMemo(
    () => groupAgentThreads(profiles, threads),
    [profiles, threads],
  );
  const allThreads = useMemo(() => [...groups.values(), orphaned].flat(), [groups, orphaned]);
  const visible = useMemo(() => {
    const { active, settled } = selectAgentWorkspaceThreads(threads, filter, query);
    return [...active, ...settled];
  }, [threads, filter, query]);
  const activeCount = (items: readonly EnvironmentThreadShell[]) =>
    items.filter((thread) => thread.settledAt === null).length;
  const online = environments.filter((env) => env.connection.phase === "connected");
  return (
    <div className="agents-page" data-thread-selected={selected} data-show-filters={showFilters}>
      <header className="agents-topbar">
        <Link to="/" className="agents-brand">
          <BrandMark className="size-4" />
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
            type="text"
            role="searchbox"
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
          <DesktopUpdateButton className="agent-icon-button agent-update-button" />
          <button
            className="agent-icon-button"
            onClick={() => openCommandPalette({ open: "add-project" })}
          >
            <PlusIcon size={14} /> Add project
          </button>
          <Link to="/settings" aria-label="Settings" className="agent-icon-button">
            <SettingsIcon size={15} />
          </Link>
        </div>
      </header>
      {!available && (
        <p role="status" className="agents-notice">
          Connect an environment with agent sync support to create or edit agents.
        </p>
      )}
      <AgentsLoadingNotice ready={ready} />
      <main className="agents-workspace" aria-label="Agents workspace">
        <aside className="agents-filters" aria-label="Agent filters">
          <header className="agents-filters-heading">
            <h2>Agents</h2>
            <button
              className="agent-primary agents-new-agent"
              disabled={!available}
              onClick={() => setEditor("new")}
            >
              <PlusIcon size={14} />
              New agent
            </button>
          </header>
          <button
            className="agent-filter"
            aria-pressed={filter === null}
            onClick={() => {
              setFilter(null);
              setShowFilters(false);
            }}
          >
            <LayoutGridIcon size={22} />
            <span className="agent-filter-body">
              <span className="agent-filter-name">All</span>
            </span>
            <span className="agent-filter-count">{activeCount(allThreads)}</span>
          </button>
          {orderedProfiles.map((profile, index) => (
            <div
              key={profile.profileId}
              className="agent-filter-row"
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
            >
              <button
                className="agent-filter"
                aria-pressed={filter === profile.profileId}
                onClick={() => {
                  setFilter(profile.profileId);
                  setShowFilters(false);
                }}
              >
                <AgentIcon icon={profile.icon} />
                <span className="agent-filter-body">
                  <span className="agent-filter-name">{profile.name}</span>
                  {profile.description && (
                    <span className="agent-filter-description">{profile.description}</span>
                  )}
                  {(profile.providerLabel || profile.modelLabel) && (
                    <span className="agent-filter-model">
                      {profile.providerLabel && profile.modelLabel
                        ? `${profile.providerLabel} · ${profile.modelLabel}`
                        : (profile.providerLabel ?? profile.modelLabel)}
                    </span>
                  )}
                </span>
                <span className="agent-filter-count">
                  {activeCount(groups.get(profile.profileId) ?? [])}
                </span>
              </button>
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
                    Move up
                  </MenuItem>
                  <MenuItem
                    disabled={index === orderedProfiles.length - 1}
                    onClick={() => moveAgent(index, 1)}
                  >
                    <ArrowRightIcon />
                    Move down
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
          ))}
          {profiles.length === 0 && (
            <p className="agent-empty">No agents yet. Create an agent to start a chat.</p>
          )}
        </aside>
        <section className="agents-threads" aria-label="Threads">
          <header>
            <button
              className="agent-mobile-filters agent-icon-button"
              onClick={() => setShowFilters(true)}
            >
              <ArrowLeftIcon size={14} /> Agents
            </button>
            <div className="agents-threads-heading">
              <h2>
                Threads
                {filter !== null
                  ? ` · ${profiles.find((profile) => profile.profileId === filter)?.name ?? "Agent unavailable"}`
                  : ""}
              </h2>
              <p>Active & unread</p>
            </div>
            <Menu>
              <MenuTrigger
                className="agent-primary agents-new-chat"
                aria-label="New chat"
                disabled={!available || orderedProfiles.length === 0}
              >
                <PlusIcon size={14} />
                New chat
              </MenuTrigger>
              <MenuPopup align="end" className="agents-new-chat-menu">
                {orderedProfiles.map((profile) => (
                  <MenuItem
                    key={profile.profileId}
                    disabled={profile.runtimeMode === "read-only"}
                    onClick={() => setTask(profile)}
                  >
                    <AgentIcon icon={profile.icon} />
                    {profile.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </header>
          {visible.length === 0 && (
            <p role="status" className="agent-empty">
              {query ? "No chats match your search." : "No threads here yet."}
            </p>
          )}
          <AgentThreadList
            threads={visible}
            profiles={profiles}
            onContextMenu={onThreadContextMenu}
          />
        </section>
        <section className="agents-chat-pane">
          <Outlet />
        </section>
      </main>
      {editor !== null && (
        <AgentEditor
          profile={editor === "new" ? null : editor}
          profiles={profiles}
          providers={online.flatMap((env) =>
            env.serverConfig
              ? visibleAgentProviders(env.environmentId, env.serverConfig.providers, {
                  providerModelPreferences: modelPreferences,
                })
              : [],
          )}
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
              Existing threads will remain visible in All. This does not stop running work.
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
