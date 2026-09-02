export const MCP_GATEWAY_ENABLED_KEY = "t3code:mcp-gateway-enabled";
export const MCP_GATEWAY_TOKEN_KEY = "t3code:mcp-gateway-bridge-token";
export const MCP_GATEWAY_STATE_EVENT = "t3code:mcp-gateway-state";

export type McpGatewayUiState = "disabled" | "connecting" | "running" | "degraded";

export function isMcpGatewayEnabled(): boolean {
  return window.localStorage.getItem(MCP_GATEWAY_ENABLED_KEY) === "true";
}

export function getMcpGatewayToken(): string {
  return window.sessionStorage.getItem(MCP_GATEWAY_TOKEN_KEY) ?? "";
}

export function setMcpGatewayToken(token: string): void {
  window.sessionStorage.setItem(MCP_GATEWAY_TOKEN_KEY, token);
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayEnabled(enabled: boolean): void {
  window.localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}
