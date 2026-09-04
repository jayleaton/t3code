import { GATEWAY_SCOPE_VALUES } from "@t3tools/client-runtime/gateway";
import type { GatewayScope } from "@t3tools/client-runtime/gateway";

export const MCP_GATEWAY_ENABLED_KEY = "t3code:mcp-gateway-enabled";
export const MCP_GATEWAY_TOKEN_KEY = "t3code:mcp-gateway-bridge-token";
export const MCP_GATEWAY_GRANTS_KEY = "t3code:mcp-gateway-grants";
export const MCP_GATEWAY_STATE_EVENT = "t3code:mcp-gateway-state";

export type McpGatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type McpGatewayUiState = "disabled" | "connecting" | "running" | "degraded";

const GATEWAY_SCOPES = new Set<GatewayScope>(GATEWAY_SCOPE_VALUES);
const MCP_GATEWAY_GRANTED_SCOPES = new Set<GatewayScope>(["read", "create", "send"]);

function sanitizeMcpGatewayGrants(value: unknown): McpGatewayGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
  for (const [environmentId, candidate] of Object.entries(value)) {
    if (environmentId.trim() === "" || !Array.isArray(candidate)) continue;
    const isValid = candidate.every(
      (scope) => typeof scope === "string" && GATEWAY_SCOPES.has(scope as GatewayScope),
    );
    if (!isValid) continue;
    const scopes = [...new Set(candidate)].filter(
      (scope): scope is GatewayScope =>
        typeof scope === "string" && MCP_GATEWAY_GRANTED_SCOPES.has(scope as GatewayScope),
    );
    if (scopes.length > 0) grants[environmentId] = scopes;
  }
  return grants;
}

export function isMcpGatewayEnabled(): boolean {
  return window.localStorage.getItem(MCP_GATEWAY_ENABLED_KEY) === "true";
}

export function getMcpGatewayToken(): string {
  return window.sessionStorage.getItem(MCP_GATEWAY_TOKEN_KEY) ?? "";
}

export function getMcpGatewayGrants(): McpGatewayGrants {
  const raw = window.localStorage.getItem(MCP_GATEWAY_GRANTS_KEY);
  if (raw === null) return {};
  try {
    return sanitizeMcpGatewayGrants(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

export function setMcpGatewayToken(token: string): void {
  window.sessionStorage.setItem(MCP_GATEWAY_TOKEN_KEY, token);
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayGrants(grants: McpGatewayGrants): void {
  window.localStorage.setItem(
    MCP_GATEWAY_GRANTS_KEY,
    JSON.stringify(sanitizeMcpGatewayGrants(grants)),
  );
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayEnabled(enabled: boolean): void {
  window.localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}
