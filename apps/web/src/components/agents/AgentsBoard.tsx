import { AgentGatewayStatus } from "./AgentGatewayStatus";
import { AgentRunDragArea, LinkableAgentCard, SortableAgentThreads } from "./SortableAgentThreads";
import { useClientSettings } from "../../hooks/useSettings";
import { visibleAgentProviders } from "./agentModelCatalog";
import { ThreadCard } from "./ThreadCard";
import { useAgentThreadContextMenu } from "./useAgentThreadContextMenu";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { AgentIcon, agentColorFor } from "./AgentIcon";
import { Link, Outlet, useLocation, useNavigate, type LinkProps } from "@tanstack/react-router";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
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
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
} from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { useScheduledTasks, useScheduledTasksSupported } from "../../state/scheduledTasks";
import { useEnvironments } from "../../state/environments";
import { useThreadShells, useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { AgentSkillsEditor } from "./AgentSkillsEditor";
import { AgentEditor } from "./AgentEditor";
import { AgentTaskDialog } from "./AgentTaskDialog";
import { AgentsLoadingNotice } from "./AgentsLoadingNotice";
import {
  excludePinnedAgentThreads,
  groupAgentThreads,
  nestAgentRuns,
  selectAgentWorkspaceThreads,
  selectPinnedAgentThreads,
  type AgentCardChildren,
  type AgentRunContextMenu,
} from "./agents.logic";
import { DesktopUpdateButton } from "../sidebar/SidebarUpdatePill";
import { BrandMark } from "../BrandMark";
import { openCommandPalette } from "../../commandPaletteBus";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

const agentFilterSchema = Schema.NullOr(Schema.String);
const agentOrderSchema = Schema.Array(Schema.String);
const emptyAgentOrder: readonly string[] = [];

function AgentThreadList({
  threads,
  pinned,
  onContextMenu,
  profiles,
  childrenByKey,
  runByKey,
}: {
  profiles: readonly McpGatewayProfile[];
  threads: readonly EnvironmentThreadShell[];
  pinned: readonly EnvironmentThreadShell[];
  childrenByKey: ReadonlyMap<string, AgentCardChildren<EnvironmentThreadShell>>;
  runByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  onContextMenu: AgentRunContextMenu;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const active = threads.filter((thread) => thread.settledAt === null);
  const settled = threads.filter((thread) => thread.settledAt !== null);
  const renderCard = (thread: EnvironmentThreadShell, dragging = false) => (
    <ThreadCard
      key={`${thread.environmentId}:${thread.id}`}
      thread={thread}
      dragging={dragging}
      profile={profiles.find((profile) => profile.profileId === thread.profileSnapshot?.profileId)}
      profiles={profiles}
      childRuns={childrenByKey.get(`${thread.environmentId}:${thread.id}`)}
      parentRun={
        thread.parentThreadId == null
          ? null
          : runByKey.get(`${thread.environmentId}:${thread.parentThreadId}`)
      }
      onContextMenu={onContextMenu}
    />
  );
  const linkableCard = (thread: EnvironmentThreadShell) => (
    <LinkableAgentCard key={`${thread.environmentId}:${thread.id}`} thread={thread}>
      {renderCard(thread)}
    </LinkableAgentCard>
  );
  return (
    <AgentRunDragArea active={active}>
      <div className="agent-thread-list">
        {pinned.length > 0 && (
          <div className="agent-pinned" aria-label="Pinned chats">
            <div className="agent-pinned-label">Pinned</div>
            {pinned.map(linkableCard)}
          </div>
        )}
        <SortableAgentThreads threads={active}>{renderCard}</SortableAgentThreads>
        {settled.length > 0 && (
          <details
            className="agent-settled"
            open={settledOpen}
            onToggle={(event) => setSettledOpen(event.currentTarget.open)}
          >
            <summary>Settled · {settled.length}</summary>
            {settledOpen && <div className="agent-thread-list">{settled.map(linkableCard)}</div>}
          </details>
        )}
      </div>
    </AgentRunDragArea>
  );
}

function TopbarIconLink({
  label,
  children,
  ...link
}: Pick<LinkProps, "to" | "search"> & { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link {...link} aria-label={label} className="agent-icon-button">
            {children}
          </Link>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function AgentsBoard() {
  const { profiles, skills, skillsAvailable, available, updateSettings } = useAgentLibrary();
  const [skillsOpen, setSkillsOpen] = useState(false);
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
  const navigate = useNavigate();
  const scheduledSupported = useScheduledTasksSupported();
  const scheduledTasks = useScheduledTasks();
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
  // Pinned chats stay at the top of the list no matter which agent filter or
  // search is active, so they are selected outside the filtered set.
  const allPinned = useMemo(() => selectPinnedAgentThreads(allThreads), [allThreads]);
  // Runs another run created fold into that run's card (see nestAgentRuns).
  const { lists: nestedLists, childrenByKey } = useMemo(() => {
    const { active, settled } = selectAgentWorkspaceThreads(threads, filter, query);
    return nestAgentRuns({
      lists: {
        pinned: allPinned,
        active: excludePinnedAgentThreads(active, allPinned),
        settled: excludePinnedAgentThreads(settled, allPinned),
      },
      all: threads,
    });
  }, [threads, filter, query, allPinned]);
  const pinned = nestedLists.pinned;
  const visible = useMemo(
    () => [...nestedLists.active, ...nestedLists.settled],
    [nestedLists.active, nestedLists.settled],
  );
  const runByKey = useMemo(
    () => new Map(threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread])),
    [threads],
  );
  const onThreadContextMenu = useAgentThreadContextMenu(visible);
  const activeCount = (items: readonly EnvironmentThreadShell[]) =>
    items.filter((thread) => thread.settledAt === null).length;
  const online = environments.filter((env) => env.connection.phase === "connected");
  // The page reads every connected server, so one offering pull requests is enough.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
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
        <AgentGatewayStatus />
        <div className="agents-topbar-actions">
          <div className="agents-topbar-group">
            <button
              className="agent-icon-button"
              disabled={!skillsAvailable}
              onClick={() => setSkillsOpen(true)}
            >
              Skills
            </button>
            <button
              className="agent-icon-button"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              <PlusIcon size={14} /> Add project
            </button>
          </div>
          <div className="agents-topbar-group agents-topbar-icons">
            <DesktopUpdateButton className="agent-icon-button agent-update-button" />
            {pullRequestsSupported && (
              <TopbarIconLink
                label="Pull Requests"
                to="/pull-requests"
                search={readPullRequestListPreferences()}
              >
                <PullRequestGlyph.pullRequest className="size-[15px]" />
              </TopbarIconLink>
            )}
            <TopbarIconLink label="Usage" to="/usage">
              <ChartNoAxesColumnIcon size={15} />
            </TopbarIconLink>
            <TopbarIconLink label="Settings" to="/settings">
              <SettingsIcon size={15} />
            </TopbarIconLink>
          </div>
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
                  "--agent-color": agentColorFor(profile, profiles),
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
                  {scheduledSupported && (
                    <MenuItem
                      disabled={!available || profile.runtimeMode === "read-only"}
                      onClick={() =>
                        navigate({ to: "/agents/scheduled", search: { agent: profile.profileId } })
                      }
                    >
                      <CalendarClockIcon />
                      Schedule task
                    </MenuItem>
                  )}
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
          {scheduledSupported && (
            <footer className="agents-filters-footer">
              <Link
                to="/agents/scheduled"
                className="agent-filter"
                activeProps={{ "aria-current": "page" }}
                onClick={() => setShowFilters(false)}
              >
                <CalendarClockIcon size={22} />
                <span className="agent-filter-body">
                  <span className="agent-filter-name">Scheduled tasks</span>
                </span>
                <span className="agent-filter-count">
                  {scheduledTasks.filter(({ task }) => task.enabled).length}
                </span>
              </Link>
            </footer>
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
            {scheduledSupported && (
              <Link to="/agents/scheduled" className="agent-mobile-filters agent-icon-button">
                <CalendarClockIcon size={14} /> Scheduled
              </Link>
            )}
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
                    <span
                      className="agents-new-chat-option"
                      style={{ "--agent-color": agentColorFor(profile, profiles) } as CSSProperties}
                    >
                      <AgentIcon icon={profile.icon} />
                      <span className="agents-new-chat-option-body">
                        <span className="agents-new-chat-option-name">{profile.name}</span>
                        {profile.description && (
                          <span className="agents-new-chat-option-description">
                            {profile.description}
                          </span>
                        )}
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </header>
          {visible.length === 0 && pinned.length === 0 && (
            <p role="status" className="agent-empty">
              {query ? "No chats match your search." : "No threads here yet."}
            </p>
          )}
          <AgentThreadList
            threads={visible}
            pinned={pinned}
            profiles={profiles}
            childrenByKey={childrenByKey}
            runByKey={runByKey}
            onContextMenu={onThreadContextMenu}
          />
        </section>
        <section className="agents-chat-pane">
          <Outlet />
        </section>
      </main>
      {skillsOpen && (
        <AgentSkillsEditor
          skills={skills}
          onClose={() => setSkillsOpen(false)}
          onSave={(agentSkills) => updateSettings({ agentSkills })}
        />
      )}
      {editor !== null && (
        <AgentEditor
          profile={editor === "new" ? null : editor}
          profiles={profiles}
          skills={skills}
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
