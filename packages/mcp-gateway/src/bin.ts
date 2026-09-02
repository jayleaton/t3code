#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createBridgeRuntimePort } from "./bridge.ts";
import type { GatewayScope } from "./port.ts";
import { createMcpGateway } from "./server.ts";

function parseGrants(
  raw: string | undefined,
): Readonly<Record<string, ReadonlyArray<GatewayScope>>> {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("T3_MCP_GRANTS must explicitly grant scopes by environment id.");
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
  for (const [environmentId, scopes] of Object.entries(value)) {
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => scope !== "read" && scope !== "create" && scope !== "send")
    ) {
      throw new Error(`Invalid scopes for environment ${environmentId}.`);
    }
    grants[environmentId] = scopes as ReadonlyArray<GatewayScope>;
  }
  return grants;
}

const bridgePort = Number.parseInt(process.env.T3_MCP_BRIDGE_PORT ?? "47631", 10);
if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
  throw new Error("T3_MCP_BRIDGE_PORT must be a valid TCP port.");
}

const bridgeToken = process.env.T3_MCP_BRIDGE_TOKEN;
if (bridgeToken === undefined || bridgeToken.length < 16) {
  throw new Error("T3_MCP_BRIDGE_TOKEN must contain at least 16 characters.");
}

const bridge = createBridgeRuntimePort({ port: bridgePort, token: bridgeToken });
const gateway = createMcpGateway({
  port: bridge.port,
  grants: parseGrants(process.env.T3_MCP_GRANTS),
});
await gateway.connect(new StdioServerTransport());

const shutdown = async () => {
  await gateway.close();
  await bridge.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
