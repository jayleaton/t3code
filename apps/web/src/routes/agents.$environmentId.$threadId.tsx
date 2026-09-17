import { Link, createFileRoute } from "@tanstack/react-router";
import ChatView from "../components/ChatView";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useThreadStatus } from "../state/entities";

export function AgentsThreadView({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const threadRef = resolveThreadRouteRef({ environmentId, threadId });
  const status = useThreadStatus(threadRef);
  return (
    <div className="agents-thread-view">
      <div className="agents-chat">
        {threadRef && status !== "deleted" ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            showBackToAgents
            routeKind="server"
          />
        ) : (
          <div className="p-6">
            <Link to="/agents" className="underline">
              Back to agents
            </Link>
            <p className="mt-4">This thread is no longer available.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agents/$environmentId/$threadId")({
  component: () => <AgentsThreadView {...Route.useParams()} />,
});
