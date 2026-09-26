import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import ChatView from "../ChatView";

export function AgentPreviewReply({
  thread,
  onSent,
}: {
  thread: EnvironmentThreadShell;
  onSent: () => void;
}) {
  return (
    <ChatView
      composerOnly
      environmentId={thread.environmentId}
      threadId={thread.id}
      routeKind="server"
      onTurnStarted={onSent}
    />
  );
}
