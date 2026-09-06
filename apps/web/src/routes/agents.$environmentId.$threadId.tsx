import { useState } from "react";
import { AgentHandoffDialog } from "../components/agents/AgentHandoffDialog";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import ChatView from "../components/ChatView";
import { resolveThreadRouteRef } from "../threadRoutes";
import { resolveThreadSyncPhase } from "../threadSync";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";

export function AgentsThreadView({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const [handoff, setHandoff] = useState(false);
  const threadRef = resolveThreadRouteRef({ environmentId, threadId });
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const phase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });
  return (
    <div className="agents-thread-view">
      <div className="agents-backbar">
        <Link to="/agents">
          <ArrowLeftIcon size={14} />
          Back to agents
        </Link>
        <button
          className="ml-auto rounded-md border px-3 py-1"
          disabled={!detail}
          onClick={() => setHandoff(true)}
        >
          Hand off
        </button>
      </div>
      {handoff && detail && (
        <AgentHandoffDialog
          sourceEnvironmentId={environmentId}
          sourceThreadId={threadId}
          initialSummary={
            detail.messages.findLast((message) => message.role === "assistant")?.text ?? ""
          }
          onClose={() => setHandoff(false)}
        />
      )}
      <div className="agents-chat">
        {threadRef && status !== "deleted" ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
            threadSyncPhase={phase}
          />
        ) : (
          <p className="p-6">This thread is no longer available.</p>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agents/$environmentId/$threadId")({
  component: () => <AgentsThreadView {...Route.useParams()} />,
});
