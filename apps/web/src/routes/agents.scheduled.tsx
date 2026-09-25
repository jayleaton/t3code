import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksPanel } from "../components/agents/ScheduledTasksPanel";

export const Route = createFileRoute("/agents/scheduled")({
  // `agent` opens the editor for a new task preset to that agent.
  validateSearch: (raw: Record<string, unknown>): { agent?: string } =>
    typeof raw.agent === "string" && raw.agent.trim() ? { agent: raw.agent } : {},
  component: ScheduledTasksRoute,
});

function ScheduledTasksRoute() {
  const { agent } = Route.useSearch();
  return <ScheduledTasksPanel key={agent ?? ""} newForProfileId={agent} />;
}
