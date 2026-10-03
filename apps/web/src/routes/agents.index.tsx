import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/agents/")({
  component: () => <p className="agent-empty">Select a thread to open its chat.</p>,
});
