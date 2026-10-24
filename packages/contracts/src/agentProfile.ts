import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Agent profile frozen onto a thread at creation, with where each effective setting came from.
 * Its instructions and skills are stored once on the server under `contentHash`: every
 * whole-thread event repeats this record, so it must stay a few hundred bytes.
 */
export const ThreadProfileSnapshot = Schema.Struct({
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
  contentHash: Schema.optional(TrimmedNonEmptyString),
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
