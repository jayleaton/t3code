import type { McpGatewayLaunchConfig } from "@t3tools/contracts";

/** Host-specific configuration for the desktop's stdio launcher. */
export function buildMcpGatewayHostConfig(
  launch: McpGatewayLaunchConfig,
  token: string,
  port: number,
) {
  const env = { ...launch.env, T3_MCP_BRIDGE_PORT: String(port), T3_MCP_BRIDGE_TOKEN: token };
  return {
    standard: { mcpServers: { "t3-gateway": { ...launch, env } } },
    opencode: {
      mcp: {
        "t3-gateway": {
          type: "local" as const,
          command: [launch.command, ...launch.args],
          environment: env,
          enabled: true,
        },
      },
    },
  };
}
