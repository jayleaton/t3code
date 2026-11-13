import type { AgentGatewayStatus } from "@t3tools/contracts";

/** One word or two for the server-hosted gateway, as web and mobile show it. */
export function agentGatewayStatusLabel(status: AgentGatewayStatus): string {
  if (status.host === "desktop") return "Hosted by the desktop app";
  if (!status.enabled) return "Off";
  switch (status.state) {
    case "running":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "standby":
      return "Standing by while the desktop app serves it";
    default:
      return status.problem === undefined ? "Disconnected" : "Failed";
  }
}
