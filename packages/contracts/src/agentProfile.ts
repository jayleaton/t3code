import * as Schema from "effect/Schema";

import { AgentSkill } from "./agentSkills.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Agent profile frozen onto a thread at creation, with where each effective setting came from. */
export const ThreadProfileSnapshot = Schema.Struct({
  skills: Schema.optional(Schema.Array(AgentSkill)),
  systemPrompt: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  profileId: Schema.NullOr(TrimmedNonEmptyString),
  profileName: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.NullOr(NonNegativeInt),
  reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  effectiveSource: Schema.Struct({
    modelSelection: Schema.Literals(["profile", "thread-override", "fallback"]),
    runtimeMode: Schema.Literals(["profile", "thread-override", "fallback"]),
    interactionMode: Schema.Literals(["profile", "thread-override", "fallback"]),
    reasoningEffort: Schema.Literals(["profile", "thread-override", "fallback"]),
  }),
});
export type ThreadProfileSnapshot = typeof ThreadProfileSnapshot.Type;

/** A profile revision chosen for a new thread, plus the fields the thread overrides. */
export const ThreadProfileSelection = Schema.Struct({
  profileId: TrimmedNonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  overrideFields: Schema.Array(
    Schema.Literals(["modelSelection", "runtimeMode", "interactionMode", "reasoningEffort"]),
  ),
});
export type ThreadProfileSelection = typeof ThreadProfileSelection.Type;
