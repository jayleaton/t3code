import type { GatewayProfile, GatewayScope } from "@t3tools/client-runtime/gateway";

export const MCP_GATEWAY_ENABLED_KEY = "t3code:mcp-gateway-enabled";
export const MCP_GATEWAY_TOKEN_KEY = "t3code:mcp-gateway-bridge-token";
export const MCP_GATEWAY_GRANTS_KEY = "t3code:mcp-gateway-grants";
export const MCP_GATEWAY_PROFILES_KEY = "t3code:mcp-gateway-profiles";
export const MCP_GATEWAY_STATE_EVENT = "t3code:mcp-gateway-state";

export type McpGatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type McpGatewayUiState = "disabled" | "connecting" | "running" | "degraded";

const GATEWAY_SCOPES = new Set<GatewayScope>(["read", "create", "send", "control", "delivery"]);

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
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
    for (const [environmentId, candidate] of Object.entries(value)) {
      if (environmentId.trim() === "" || !Array.isArray(candidate)) continue;
      const scopes = [...new Set(candidate)].filter(
        (scope): scope is GatewayScope =>
          typeof scope === "string" && GATEWAY_SCOPES.has(scope as GatewayScope),
      );
      const isValid = candidate.every(
        (scope) => typeof scope === "string" && GATEWAY_SCOPES.has(scope as GatewayScope),
      );
      if (isValid && scopes.length > 0) grants[environmentId] = scopes;
    }
    return grants;
  } catch {
    return {};
  }
}

export function getMcpGatewayProfiles(): ReadonlyArray<GatewayProfile> {
  const raw = window.localStorage.getItem(MCP_GATEWAY_PROFILES_KEY);
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((candidate): candidate is GatewayProfile => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
        return false;
      const profile = candidate as Record<string, unknown>;
      const modelSelection = profile.modelSelection;
      return (
        typeof profile.name === "string" &&
        profile.name.trim() !== "" &&
        (profile.profileId === undefined ||
          (typeof profile.profileId === "string" && profile.profileId.trim() !== "")) &&
        (profile.revision === undefined ||
          (typeof profile.revision === "number" &&
            Number.isInteger(profile.revision) &&
            profile.revision >= 1)) &&
        (profile.createdAt === undefined || typeof profile.createdAt === "string") &&
        (profile.updatedAt === undefined || typeof profile.updatedAt === "string") &&
        typeof modelSelection === "object" &&
        modelSelection !== null &&
        !Array.isArray(modelSelection) &&
        typeof (modelSelection as Record<string, unknown>).instanceId === "string" &&
        (modelSelection as Record<string, unknown>).instanceId !== "" &&
        typeof (modelSelection as Record<string, unknown>).model === "string" &&
        (modelSelection as Record<string, unknown>).model !== "" &&
        (profile.runtimeMode === "approval-required" ||
          profile.runtimeMode === "auto-accept-edits" ||
          profile.runtimeMode === "auto" ||
          profile.runtimeMode === "full-access") &&
        (profile.interactionMode === "default" || profile.interactionMode === "plan")
      );
    });
  } catch {
    return [];
  }
}

export function setMcpGatewayProfiles(profiles: ReadonlyArray<GatewayProfile>): void {
  window.localStorage.setItem(MCP_GATEWAY_PROFILES_KEY, JSON.stringify(profiles));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayToken(token: string): void {
  window.sessionStorage.setItem(MCP_GATEWAY_TOKEN_KEY, token);
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayGrants(grants: McpGatewayGrants): void {
  window.localStorage.setItem(MCP_GATEWAY_GRANTS_KEY, JSON.stringify(grants));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayEnabled(enabled: boolean): void {
  window.localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}
