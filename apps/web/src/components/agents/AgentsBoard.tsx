import { Link } from "@tanstack/react-router";
import { useMemo, useState, type CSSProperties } from "react";
import { PlusIcon, SettingsIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { McpGatewayProfile } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useThreadShells, useAllEnvironmentShellsBootstrapped } from "../../state/entities";
import { AgentEditor } from "./AgentEditor";
import { AgentTaskDialog } from "./AgentTaskDialog";
import { agentThreadStatus, groupAgentThreads } from "./agents.logic";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

const colors = ["#f5b775", "#7bb5ff", "#b797ff", "#71d8bc", "#f293b7"];

function ThreadCard({
  thread,
  profile,
  machine,
}: {
  thread: EnvironmentThreadShell;
  profile?: McpGatewayProfile;
  machine: string;
}) {
  const status = agentThreadStatus(thread);
  const snapshot = thread.profileSnapshot;
  const old = profile && snapshot && snapshot.revision !== profile.revision;
  return (
    <Link
      className={`agent-thread agent-thread-${status}`}
      to="/agents/$environmentId/$threadId"
      params={{ environmentId: thread.environmentId, threadId: thread.id }}
    >
      <div className="agent-thread-title">
        <strong>{thread.title}</strong>
        <span className={`agent-status agent-status-${status}`}>{status}</span>
      </div>
      <div className="agent-thread-meta">
        <span>
          {status === "running" && <i className="agent-live-dot" />}
          {machine}
        </span>
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
    </Link>
  );
}

export function AgentsBoard() {
  const profiles = usePrimarySettings((settings) => settings.mcpGatewayProfiles);
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const [editor, setEditor] = useState<McpGatewayProfile | "new" | null>(null);
  const [task, setTask] = useState<{ profile: McpGatewayProfile; kind: "Task" | "Chat" } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<McpGatewayProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const { groups, orphaned } = useMemo(
    () => groupAgentThreads(profiles, threads),
    [profiles, threads],
  );
  const online = environments.filter((env) => env.connection.phase === "connected");
  const machineLabel = (id: string) =>
    environments.find((env) => env.environmentId === id)?.label ?? id;
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
        <span className="agents-online">
          {online.length} {online.length === 1 ? "machine" : "machines"} online
        </span>
        <div className="agents-topbar-actions">
          <span className="agents-connected">
            <i className="agent-live-dot" />
            {online.map((env) => env.label).join(" · ") || "Offline"}
          </span>
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
          Connect a primary environment to create or edit agents.
        </p>
      )}
      {!ready && (
        <p role="status" className="agents-notice">
          Loading connected environments…
        </p>
      )}
      <main className="agents-board" aria-label="Agents board">
        {profiles.map((profile, index) => (
          <section
            key={profile.profileId}
            className="agent-column"
            style={{ "--agent-color": colors[index % colors.length] } as CSSProperties}
            aria-label={`${profile.name} agent`}
          >
            <div className="agent-column-header">
              <div className="agent-heading">
                <span className="agent-orb" />
                <h2>{profile.name}</h2>
                <span className="agent-durable">Agent</span>
                <button
                  className="agent-icon-button"
                  aria-label={`Edit ${profile.name}`}
                  disabled={!available}
                  onClick={() => setEditor(profile)}
                >
                  <PencilIcon size={13} />
                </button>
                <button
                  className="agent-icon-button"
                  aria-label={`Delete ${profile.name}`}
                  disabled={!available}
                  onClick={() => {
                    setDeleting(profile);
                    setDeleteError("");
                  }}
                >
                  <Trash2Icon size={13} />
                </button>
              </div>
              <div className="agent-chips">
                <span className="agent-provider">
                  {profile.providerLabel ?? profile.modelSelection?.instanceId ?? "Select provider"}
                </span>
                <span>{profile.modelLabel ?? profile.modelSelection?.model ?? "Select model"}</span>
                <span>thinking {profile.reasoningEffort ?? "default"}</span>
                <span>
                  machine:{" "}
                  {profile.environmentIds?.length
                    ? profile.environmentIds.map(machineLabel).join(", ")
                    : "any"}
                </span>
              </div>
              <div className="agent-task-actions">
                {(["Task", "Chat"] as const).map((kind) => (
                  <button
                    key={kind}
                    disabled={profile.runtimeMode === "read-only"}
                    onClick={() => setTask({ profile, kind })}
                  >
                    + {kind}
                  </button>
                ))}
              </div>
              {profile.runtimeMode === "read-only" && (
                <p className="text-xs text-muted-foreground">
                  Read-only profiles cannot start threads.
                </p>
              )}
            </div>
            <div className="agent-thread-list">
              {groups.get(profile.profileId)?.map((thread) => (
                <ThreadCard
                  key={`${thread.environmentId}:${thread.id}`}
                  thread={thread}
                  profile={profile}
                  machine={machineLabel(thread.environmentId)}
                />
              ))}
              {groups.get(profile.profileId)?.length === 0 && (
                <p className="agent-empty">
                  Ready when you are.
                  <br />
                  Start a task or open a chat.
                </p>
              )}
            </div>
          </section>
        ))}
        {orphaned.length > 0 && (
          <section className="agent-column agent-orphaned" aria-label="Removed agents">
            <div className="agent-column-header">
              <h2>Removed agents</h2>
              <p className="text-xs text-muted-foreground mt-2">
                Their conversations are still here.
              </p>
            </div>
            <div className="agent-thread-list">
              {orphaned.map((thread) => (
                <ThreadCard
                  key={`${thread.environmentId}:${thread.id}`}
                  thread={thread}
                  machine={machineLabel(thread.environmentId)}
                />
              ))}
            </div>
          </section>
        )}
        <button className="agent-new-column" disabled={!available} onClick={() => setEditor("new")}>
          <span className="agent-new-icon">
            <PlusIcon />
          </span>
          <strong>New agent</strong>
          <span>
            Name a specialist. Pin provider,
            <br />
            model, thinking, and machines.
            <br />
            Give it a task when you’re ready.
          </span>
        </button>
      </main>
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
      {task && <AgentTaskDialog {...task} onClose={() => setTask(null)} />}
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
