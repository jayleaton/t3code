import { OrchestratorMcpFailure, type ThreadProfileSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { agentProfileSelection } from "../orchestration-v2/AgentProfile.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Resolves an MCP caller's profileId to the agent's current revision. An
 * unknown id fails instead of silently creating a plain thread. The profile is
 * returned so callers can check its modes against their own limits.
 */
export const resolveMcpProfileSelection = Effect.fn("resolveMcpProfileSelection")(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
  profileId: string,
  overrides: Parameters<typeof agentProfileSelection>[2],
) {
  const library = yield* settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "Agent profiles could not be read.",
        }),
    ),
  );
  const selection: ThreadProfileSelection | undefined = agentProfileSelection(
    library.mcpGatewayProfiles,
    profileId,
    overrides,
  );
  if (selection === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Unknown agent profileId '${profileId}'. Use t3_list_agents to find a valid profileId.`,
    });
  }
  const profile = library.mcpGatewayProfiles.find(
    (candidate) => candidate.profileId === profileId,
  )!;
  return { selection, profile };
});
