import { createFileRoute } from "@tanstack/react-router";

import { McpGatewaySettings } from "../components/settings/McpGatewaySettings";

export const Route = createFileRoute("/_chat/settings/mcp-gateway")({
  component: McpGatewaySettings,
});
