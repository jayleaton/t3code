import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useThreadDetail, useThreadStatus } from "../../state/entities";
import { agentThreadStatus } from "./agents.logic";

export function AgentChatPreview({
  thread,
  project,
}: {
  thread: EnvironmentThreadShell;
  project: string;
}) {
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const detail = useThreadDetail(ref);
  const status = useThreadStatus(ref);
  const messages = detail?.messages.filter((message) => message.role !== "system").slice(-4) ?? [];
  return (
    <section aria-label="Chat preview">
      <header>
        <strong>{thread.title}</strong>
        <span>
          {thread.session?.status === "error" ? "Needs attention" : agentThreadStatus(thread)}
        </span>
        <span>{project}</span>
        <span>
          {thread.profileSnapshot?.profileName ?? "Chat"} · {thread.modelSelection.model}
        </span>
      </header>
      {status === "cached" && <p role="status">Offline · showing saved messages</p>}
      {!detail && (
        <p role="status">
          {status === "deleted" ? "This chat is no longer available." : "Loading recent messages…"}
        </p>
      )}
      {detail && messages.length === 0 && <p>No messages yet.</p>}
      <div className="agent-preview-messages">
        {messages.map((message) => (
          <article key={message.id}>
            <strong>
              {message.role === "user" ? "You" : "Agent"}
              {message.streaming ? " · writing…" : ""}
            </strong>
            <p>
              {message.text.slice(0, 1600)}
              {message.text.length > 1600 ? "…" : ""}
            </p>
            {message.attachments?.length ? (
              <small>{message.attachments.length} attachments</small>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
