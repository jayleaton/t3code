#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// @effect-diagnostics-next-line nodeBuiltinImport:off - Gateway state directory is initialized synchronously before the Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Gateway state path is initialized synchronously before the Effect runtime exists.
import * as NodePath from "node:path";

import { createBridgeRuntimePort } from "./bridge.ts";
import { startWebhookDeliveryWorker } from "./deliver.ts";
import { createGatewayEventStore } from "./events.ts";
import { GATEWAY_SCOPE_VALUES, hasGatewayScopes } from "./port.ts";
import type { GatewayScope } from "./port.ts";
import { createMcpGateway } from "./server.ts";

function parseGrants(
  raw: string | undefined,
): Readonly<Record<string, ReadonlyArray<GatewayScope>>> {
  if (raw === undefined || raw.trim() === "") return {};
  const value = JSON.parse(raw) as Record<string, unknown>;
  const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
  for (const [environmentId, scopes] of Object.entries(value)) {
    if (
      !Array.isArray(scopes) ||
      scopes.some(
        (scope) =>
          typeof scope !== "string" || !GATEWAY_SCOPE_VALUES.includes(scope as GatewayScope),
      )
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

const initialGrants = parseGrants(process.env.T3_MCP_GRANTS);
const repositoryAllowlist = (process.env.T3_MCP_REPOSITORY_ALLOWLIST ?? "jayleaton/t3code")
  .split(",")
  .map((repository) => repository.trim())
  .filter((repository) => /^[^/\s]+\/[^/\s]+$/u.test(repository));
if (repositoryAllowlist.length === 0) {
  throw new Error("T3_MCP_REPOSITORY_ALLOWLIST must contain owner/repository entries.");
}
const retentionEvents = Number.parseInt(process.env.T3_MCP_EVENT_RETENTION ?? "100000", 10);
if (!Number.isInteger(retentionEvents) || retentionEvents < 1) {
  throw new Error("T3_MCP_EVENT_RETENTION must be a positive integer.");
}
const stateDirectory = process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3code");
NodeFS.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
const stateFile =
  process.env.T3_MCP_STATE_FILE ?? NodePath.join(stateDirectory, "mcp-gateway-v3.sqlite");
const eventStore = createGatewayEventStore({ file: stateFile, retentionEvents });
const bridge = createBridgeRuntimePort({
  port: bridgePort,
  token: bridgeToken,
  initialGrants,
  getEventCursor: eventStore.latestSequence,
  onEvent: eventStore.ingest,
  getStatusSnapshot: eventStore.statusSnapshot,
  onStatusChange: eventStore.onStatusChange,
});
const gateway = createMcpGateway({
  port: bridge.port,
  grants: bridge.getGrants,
  repositoryAllowlist,
  events: eventStore,
  health: bridge.getHealth,
});
const deliveryWorker = startWebhookDeliveryWorker(eventStore, {
  isAuthorized: (environmentId) =>
    hasGatewayScopes(bridge.getGrants(), environmentId, ["read", "delivery"]),
});
const startup = await bridge.ready;
if (startup.status === "degraded") {
  process.stderr.write(`${JSON.stringify({ component: "t3-mcp-gateway", ...startup })}\n`);
}
await gateway.connect(new StdioServerTransport());

const shutdown = async () => {
  deliveryWorker.stop();
  await gateway.close();
  await bridge.close();
  eventStore.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
