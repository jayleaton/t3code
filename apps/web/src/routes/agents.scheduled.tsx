import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { ScheduledTaskList } from "../components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { Button } from "../components/ui/button";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";

export const Route = createFileRoute("/agents/scheduled")({
  // `agent` opens the editor for a new task preset to that agent.
  validateSearch: (raw: Record<string, unknown>): { agent?: string } =>
    typeof raw.agent === "string" && raw.agent.trim() ? { agent: raw.agent } : {},
  component: ScheduledTasksRoute,
});

const ALL_SCOPE = {};

function ScheduledTasksRoute() {
  const { agent } = Route.useSearch();
  const navigate = useNavigate({ from: "/agents/scheduled" });
  return (
    <SettingsScopeProvider search={ALL_SCOPE} onChange={() => {}}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          <div className="md:hidden">
            <Button size="sm" variant="ghost" render={<Link to="/agents" />}>
              <ArrowLeftIcon />
              Agents
            </Button>
          </div>
          <ScheduledTaskList
            initialFilter="agent"
            profileId={agent}
            onLinkClosed={() => void navigate({ search: {}, replace: true })}
          />
        </WorkspacePageContainer>
      </div>
    </SettingsScopeProvider>
  );
}
