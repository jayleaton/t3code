import {
  type McpGatewayProfile,
  type AgentSkill,
  type ServerProvider,
  type ThreadProfileSelection,
  type ThreadProfileSnapshot,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

import {
  type ProfileSnapshotContent,
  profileSnapshotContentHash,
} from "./ProfileSnapshotContent.ts";

/**
 * Selects an agent's current revision for a new thread. Fields the caller set
 * explicitly stay thread overrides; everything else follows the agent.
 * Returns undefined when no agent has this id.
 */
export function agentProfileSelection(
  profiles: ReadonlyArray<McpGatewayProfile>,
  profileId: string,
  overrides: {
    readonly modelSelection?: boolean;
    readonly reasoningEffort?: boolean;
    readonly runtimeMode?: boolean;
    readonly interactionMode?: boolean;
  },
): ThreadProfileSelection | undefined {
  const profile = profiles.find((candidate) => candidate.profileId === profileId);
  if (profile === undefined) return undefined;
  return {
    profileId,
    revision: profile.revision,
    overrideFields: (
      ["modelSelection", "reasoningEffort", "runtimeMode", "interactionMode"] as const
    ).filter((field) => overrides[field] === true),
  };
}

export function resolveThreadCreateProfile<
  T extends {
    readonly modelSelection?: McpGatewayProfile["modelSelection"] | undefined;
    readonly runtimeMode?: McpGatewayProfile["runtimeMode"] | undefined;
    readonly interactionMode?: McpGatewayProfile["interactionMode"] | undefined;
    readonly profileSelection?:
      | {
          readonly profileId: string;
          readonly revision: number;
          readonly overrideFields: ReadonlyArray<
            "modelSelection" | "runtimeMode" | "interactionMode" | "reasoningEffort"
          >;
        }
      | undefined;
  },
>(
  command: T,
  profiles: ReadonlyArray<McpGatewayProfile>,
  providers: ReadonlyArray<ServerProvider> = [],
  skills: ReadonlyArray<AgentSkill> = [],
): T & {
  readonly profileSnapshot?: ThreadProfileSnapshot;
  readonly profileContent?: ProfileSnapshotContent;
} {
  const selection = command.profileSelection;
  if (selection === undefined) return command;
  const profile = profiles.find((candidate) => candidate.profileId === selection.profileId);
  if (profile === undefined || profile.revision !== selection.revision) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' revision ${selection.revision} is stale or missing.`,
    });
  }
  if (profile.runtimeMode === "read-only") {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' is read-only and cannot create a thread.`,
    });
  }
  const overrides = new Set(selection.overrideFields);
  if (overrides.has("modelSelection") && command.modelSelection === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' requested a model override without a model selection.`,
    });
  }
  const reasoningEffort = profile.reasoningEffort;
  const readableMatches: ReadonlyArray<NonNullable<McpGatewayProfile["modelSelection"]>> =
    profile.providerLabel === undefined || profile.modelLabel === undefined
      ? []
      : providers.flatMap((provider) => {
          const providerLabel = provider.displayName?.trim() || provider.driver;
          if (
            provider.enabled !== true ||
            provider.availability === "unavailable" ||
            providerLabel !== profile.providerLabel
          ) {
            return [];
          }
          return provider.models
            .filter(
              (model) => model.slug === profile.modelLabel || model.name === profile.modelLabel,
            )
            .map((model) => ({ instanceId: provider.instanceId, model: model.slug }));
        });
  if (readableMatches.length > 1) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' has an ambiguous provider/model selection (${profile.providerLabel} / ${profile.modelLabel}).`,
    });
  }
  const profileModelSelection =
    profile.modelSelection ??
    readableMatches[0] ??
    (overrides.has("modelSelection") ||
    (profile.providerLabel === undefined && profile.modelLabel === undefined)
      ? command.modelSelection
      : undefined);
  if (profileModelSelection === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' provider/model is no longer available (${profile.providerLabel ?? "unselected"} / ${profile.modelLabel ?? "unselected"}).`,
    });
  }
  const baseModelSelection =
    overrides.has("modelSelection") && command.modelSelection !== undefined
      ? command.modelSelection
      : profileModelSelection;
  const inheritedOptions = baseModelSelection.options ?? [];
  const modelSelection =
    reasoningEffort === undefined || overrides.has("reasoningEffort")
      ? baseModelSelection
      : {
          ...baseModelSelection,
          options: [
            ...inheritedOptions.filter((option) => option.id !== "reasoningEffort"),
            { id: "reasoningEffort", value: reasoningEffort },
          ],
        };
  const runtimeMode = overrides.has("runtimeMode") ? command.runtimeMode : profile.runtimeMode;
  const interactionMode = overrides.has("interactionMode")
    ? command.interactionMode
    : profile.interactionMode;
  if (runtimeMode === undefined || interactionMode === undefined) {
    throw new OrchestrationDispatchCommandError({
      message: `Gateway profile '${selection.profileId}' declared an override without an explicit value.`,
    });
  }
  const source = (
    field: "modelSelection" | "runtimeMode" | "interactionMode" | "reasoningEffort",
  ) => (overrides.has(field) ? ("thread-override" as const) : ("profile" as const));
  const profileContent: ProfileSnapshotContent = {
    ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
    skills: skills.filter((skill) => profile.skillIds?.includes(skill.skillId)),
  };
  return {
    ...command,
    modelSelection,
    runtimeMode,
    interactionMode,
    profileContent,
    profileSnapshot: {
      profileId: profile.profileId,
      profileName: profile.name,
      revision: profile.revision,
      contentHash: profileSnapshotContentHash(profileContent),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      effectiveSource: {
        modelSelection: source("modelSelection"),
        runtimeMode: source("runtimeMode"),
        interactionMode: source("interactionMode"),
        reasoningEffort: source("reasoningEffort"),
      },
    },
  };
}

/** Frozen per-thread instructions follow the thread through provider switches. */
export function agentProfilePrompt(text: string, systemPrompt: string | undefined): string {
  const instructions = systemPrompt?.trim();
  return instructions
    ? `<agent_profile_instructions>\n${instructions}\n</agent_profile_instructions>\n\n${text}`
    : text;
}

/**
 * Turns that skip the full instructions still name them: hundreds of thousands of tokens later,
 * a model stops honoring per-turn duties it can no longer see. Built only from frozen profile
 * content, so the bytes stay identical turn to turn and keep the provider's prompt cache warm.
 */
export function agentProfileReminder(
  text: string,
  profileName: string | null | undefined,
  content: ProfileSnapshotContent,
): string {
  if (!content.systemPrompt?.trim() && content.skills.length === 0) return text;
  const skillNames = content.skills.map((skill) => skill.name);
  const agent = profileName ? `the T3 agent "${profileName}"` : "a T3 agent";
  const skills = skillNames.length === 0 ? "" : ` and assigned skills (${skillNames.join(", ")})`;
  return `<agent_profile_reminder>You are running as ${agent}. Your agent_profile_instructions${skills} from the start of this conversation still apply; re-read a skill's SKILL.md when its trigger applies.</agent_profile_reminder>\n\n${text}`;
}

/**
 * Whether this native conversation still holds the exact instructions the next prompt would
 * prepend, so repeating them would only grow every later turn's context. Every adapter keeps
 * native history across turns and binds a new native id when it cannot resume one, so an
 * accepted prompt under the same native id is still in context unless a compaction summarized it
 * or a rollback removed it. Changed content is resent because the newest copy is authoritative.
 */
export function agentInstructionsInContext(input: {
  readonly profileContentHash: string;
  readonly nativeThreadId: string | undefined;
  readonly run: Pick<OrchestrationV2Run, "providerThreadId">;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "providerThreadId">
  >;
  readonly attempts: ReadonlyArray<
    Pick<
      OrchestrationV2RunAttempt,
      | "id"
      | "runId"
      | "attemptOrdinal"
      | "providerThreadId"
      | "nativeThreadId"
      | "profileContentHash"
    >
  >;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "status">
  >;
  /** Manual `/compact` runs and runs whose provider reported a compaction. */
  readonly compactedRunIds: ReadonlySet<string>;
}): boolean {
  if (input.nativeThreadId === undefined) return false;
  const accepted = new Set(
    input.providerTurns
      .filter((turn) => turn.status === "completed" || turn.status === "interrupted")
      .map((turn) => turn.runAttemptId),
  );
  const ordinals = new Map(
    input.runs
      .filter(
        (run) =>
          run.providerThreadId === input.run.providerThreadId && run.status !== "rolled_back",
      )
      .map((run) => [run.id, run.ordinal]),
  );
  const latest = input.attempts
    .filter(
      (attempt) =>
        attempt.profileContentHash !== undefined &&
        attempt.providerThreadId === input.run.providerThreadId &&
        attempt.nativeThreadId === input.nativeThreadId &&
        accepted.has(attempt.id) &&
        ordinals.has(attempt.runId),
    )
    .map((attempt) => ({ attempt, ordinal: ordinals.get(attempt.runId)! }))
    .toSorted(
      (a, b) => a.ordinal - b.ordinal || a.attempt.attemptOrdinal - b.attempt.attemptOrdinal,
    )
    .at(-1);
  if (latest === undefined || latest.attempt.profileContentHash !== input.profileContentHash)
    return false;
  // A compaction in the delivering run itself may already have summarized the instructions away.
  return ![...ordinals].some(
    ([runId, ordinal]) => ordinal >= latest.ordinal && input.compactedRunIds.has(runId),
  );
}
