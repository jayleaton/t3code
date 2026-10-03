export function resolveMcpGatewayLaunchConfig(input: {
  readonly isPackaged: boolean;
  readonly executablePath: string;
  readonly resourcesPath: string;
  readonly stateFile: string;
}) {
  if (!input.isPackaged) return null;
  return {
    command: input.executablePath,
    args: [`${input.resourcesPath}/t3-mcp-gateway.mjs`],
    env: { ELECTRON_RUN_AS_NODE: "1", T3_MCP_STATE_FILE: input.stateFile },
  };
}
