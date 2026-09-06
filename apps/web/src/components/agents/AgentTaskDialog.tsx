import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  createGatewayRuntimePortFromContext,
  resolveGatewayProfileModelSelection,
} from "@t3tools/client-runtime/gateway";
import { EnvironmentId, ThreadId, type McpGatewayProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { toastManager } from "../ui/toast";
import { randomUUID } from "../../lib/utils";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

export function AgentTaskDialog({
  profile,
  kind,
  onClose,
}: {
  profile: McpGatewayProfile;
  kind: "Task" | "Chat";
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const runtime = useAtomValue(connectionAtomRuntime);
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [machine, setMachine] = useState("");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const eligible = environments.filter(
    (env) =>
      env.connection.phase === "connected" &&
      (!profile.environmentIds?.length || profile.environmentIds.includes(env.environmentId)) &&
      resolveGatewayProfileModelSelection(profile, env.serverConfig?.providers ?? []) !== undefined,
  );
  const target =
    eligible.find((env) => env.environmentId === machine) ??
    (machine === "" ? eligible[0] : undefined);
  const targetProjects = projects
    .filter((project) => project.environmentId === target?.environmentId)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const project = targetProjects.find((item) => item.id === projectId) ?? targetProjects[0];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="agent-dialog p-6">
        <DialogTitle>
          New {kind.toLowerCase()} · {profile.name}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Start with this agent’s current profile. Leave the prompt empty to open a chat without
          starting work.
        </DialogDescription>
        <form
          className="agent-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!target || !project || runtime._tag !== "Success") return;
            setBusy(true);
            setError("");
            let createdThreadId: string | undefined;
            try {
              const port = createGatewayRuntimePortFromContext(runtime.value);
              // Read the target's saved revision; never override its catalog resolution.
              const saved = (await port.listProfiles!(target.environmentId)).find(
                (item) => item.profileId === profile.profileId,
              );
              if (!saved || saved.revision !== profile.revision)
                throw new Error(
                  "This machine has a different agent revision. Sync settings and try again.",
                );
              const threadId = randomUUID();
              await port.createThread({
                environmentId: target.environmentId,
                projectId: project.id,
                threadId,
                title:
                  title.trim() ||
                  prompt.trim().slice(0, 100) ||
                  `New ${profile.name} ${kind.toLowerCase()}`,
                requestId: randomUUID(),
                profileSelection: {
                  profileId: profile.profileId,
                  revision: profile.revision,
                  overrideFields: [],
                },
              });
              createdThreadId = threadId;
              if (prompt.trim())
                await port.sendMessage({
                  environmentId: target.environmentId,
                  threadId,
                  text: prompt.trim(),
                  messageId: randomUUID(),
                  requestId: randomUUID(),
                });
              await navigate({
                to: "/agents/$environmentId/$threadId",
                params: { environmentId: target.environmentId, threadId: ThreadId.make(threadId) },
              });
              onClose();
            } catch (cause) {
              if (createdThreadId) {
                toastManager.add({
                  type: "warning",
                  title: "Thread created, message not sent",
                  description: "Open the thread and send your prompt again.",
                });
                await navigate({
                  to: "/agents/$environmentId/$threadId",
                  params: {
                    environmentId: EnvironmentId.make(target.environmentId),
                    threadId: ThreadId.make(createdThreadId),
                  },
                });
                onClose();
              }
              setError(cause instanceof Error ? cause.message : "Could not create thread.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Machine
            <select
              value={machine}
              onChange={(e) => {
                setMachine(e.target.value);
                setProjectId("");
              }}
            >
              <option value="">Any available machine{target ? ` · ${target.label}` : ""}</option>
              {eligible.map((env) => (
                <option key={env.environmentId} value={env.environmentId}>
                  {env.label}
                </option>
              ))}
            </select>
          </label>
          {!target && (
            <p role="alert">
              No connected machine can uniquely resolve this provider and model. Re-select on this
              machine.
            </p>
          )}
          <label>
            Project
            <select
              required
              value={project?.id ?? ""}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="" disabled>
                Select project
              </option>
              {targetProjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {target && !project && (
            <p>Add a project on {target.label} from the Threads view first.</p>
          )}
          <label>
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What are we working on?"
            />
          </label>
          <label>
            Prompt <span className="text-muted-foreground">· optional</span>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Give your agent a task…"
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="agent-primary"
              disabled={
                busy ||
                !target ||
                !project ||
                !AsyncResult.isSuccess(runtime) ||
                profile.runtimeMode === "read-only"
              }
            >
              {busy ? "Creating…" : `Create ${kind.toLowerCase()}`}
            </button>
          </footer>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
