import type {
  ExecutionEnvironmentCapabilities,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { isModelSelectionProviderEnabled } from "@t3tools/shared/serverSettings";
import * as Struct from "effect/Struct";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

const SHARED_SERVER_SETTING_KEYS = [
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "autoResumeLimitedThreads",
  "snoozeLimitedThreads",
  "snoozePresets",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
  "agentSkills",
  "agentSkillDeletedAt",
  "mcpGatewayProfiles",
  "mcpGatewayProfileDeletedAt",
  "textGenerationModelSelection",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

const SHARED_KEY_SET = new Set<string>(SHARED_SERVER_SETTING_KEYS);

export function splitSharedServerPatch(patch: ServerSettingsPatch): {
  sharedPatch: ServerSettingsPatch;
  localPatch: ServerSettingsPatch;
} {
  const sharedPatch: Record<string, unknown> = {};
  const localPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SHARED_KEY_SET.has(key)) {
      sharedPatch[key] = value;
    } else {
      localPatch[key] = value;
    }
  }
  return {
    sharedPatch: sharedPatch as ServerSettingsPatch,
    localPatch: localPatch as ServerSettingsPatch,
  };
}

export function filterSharedServerPatch(
  patch: ServerSettingsPatch,
  capabilities:
    | Pick<
        ExecutionEnvironmentCapabilities,
        "threadRestartContinuation" | "agentSkillsSync" | "agentSkillResources"
      >
    | undefined,
  settings?: ServerSettings,
  sourceSettings = settings,
  targetIsSource = false,
): ServerSettingsPatch {
  if (capabilities?.agentSkillsSync !== true) {
    patch = Struct.omit(patch, ["agentSkills", "agentSkillDeletedAt"]);
    if (patch.mcpGatewayProfiles)
      patch = {
        ...patch,
        mcpGatewayProfiles: patch.mcpGatewayProfiles.map(
          ({ skillIds: _skillIds, ...profile }) => profile,
        ),
      };
  }
  if (
    capabilities?.agentSkillResources !== true &&
    patch.agentSkills?.some((skill) => skill.resources?.length)
  ) {
    patch = Struct.omit(patch, ["agentSkills", "agentSkillDeletedAt"]);
  }
  const instanceId =
    patch.textGenerationModelSelection?.instanceId ??
    sourceSettings?.textGenerationModelSelection.instanceId;
  if (
    !targetIsSource &&
    patch.textGenerationModelSelection &&
    (!settings ||
      (instanceId !== undefined &&
        (sourceSettings?.providerInstances[instanceId]?.driver ?? instanceId) !==
          (settings.providerInstances[instanceId]?.driver ?? instanceId)) ||
      !isModelSelectionProviderEnabled(settings, {
        ...settings.textGenerationModelSelection,
        ...patch.textGenerationModelSelection,
      }))
  ) {
    patch = Struct.omit(patch, ["textGenerationModelSelection"]);
  }
  return capabilities?.threadRestartContinuation === true
    ? patch
    : Struct.omit(patch, ["continueThreadsAfterServerUpdate"]);
}

export function supportsSharedSettingsSync(environment: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: object | null;
}): boolean {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}
