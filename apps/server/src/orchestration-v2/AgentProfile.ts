import {
  type McpGatewayProfile,
  type ServerProvider,
  type ThreadProfileSnapshot,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";

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
): T & { readonly profileSnapshot?: ThreadProfileSnapshot } {
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
  return {
    ...command,
    modelSelection,
    runtimeMode,
    interactionMode,
    profileSnapshot: {
      profileId: profile.profileId,
      profileName: profile.name,
      ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
      revision: profile.revision,
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
export function agentProfilePrompt(
  text: string,
  profile: ThreadProfileSnapshot | undefined,
): string {
  const instructions = profile?.systemPrompt?.trim();
  return instructions
    ? `<agent_profile_instructions>\n${instructions}\n</agent_profile_instructions>\n\n${text}`
    : text;
}
