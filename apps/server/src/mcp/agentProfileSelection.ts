import {
  type McpGatewayProfile,
  OrchestratorMcpFailure,
  type ThreadProfileSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { agentProfileSelection } from "../orchestration-v2/AgentProfile.ts";
import * as ServerSettings from "../serverSettings.ts";

type ProfileOverrides = Parameters<typeof agentProfileSelection>[2];

/**
 * Resolves an MCP caller's profileId to the agent's current revision. An
 * unknown or read-only agent fails with a reason the calling agent can report,
 * instead of silently creating a plain thread. Overrides may depend on the
 * agent, e.g. to clamp its modes to the caller's.
 */
export const resolveMcpProfileSelection = Effect.fn("resolveMcpProfileSelection")(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
  profileId: string,
  overrides: ProfileOverrides | ((profile: McpGatewayProfile) => ProfileOverrides),
) {
  const library = yield* settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `Agent profileId '${profileId}' could not be resolved: this environment's agent settings could not be read.`,
        }),
    ),
  );
  const profile = library.mcpGatewayProfiles.find((candidate) => candidate.profileId === profileId);
  if (profile === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Unknown agent profileId '${profileId}' in this environment. Agents are per environment; use orchestrator_capabilities.agents (or t3_list_agents with this environmentId) for valid profileIds.`,
    });
  }
  if (profile.runtimeMode === "read-only") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Agent '${profile.name}' (${profileId}) is read-only and cannot run work.`,
    });
  }
  const selection: ThreadProfileSelection = agentProfileSelection(
    library.mcpGatewayProfiles,
    profileId,
    typeof overrides === "function" ? overrides(profile) : overrides,
  )!;
  return { selection, profile };
});
