import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Credentials for the voice assistant live in the environment that brokers the
 * live session, not in whichever agent environment happens to be selected in
 * chat. The client always names the owning environment explicitly; the server
 * never guesses. Gemini is the only implemented conversation provider, OpenAI
 * is a planned adapter (its credential can be stored, but never presented as
 * usable), and Jev/TypeSafe is the optional decision-routing helper.
 */
export const VoiceProviderId = Schema.Literals(["gemini", "openai", "jev"]);
export type VoiceProviderId = typeof VoiceProviderId.Type;

/** Conversation providers, in the order the selector should present them. */
export const VOICE_CONVERSATION_PROVIDER_IDS = ["gemini", "openai"] as const;
export type VoiceConversationProviderId = (typeof VOICE_CONVERSATION_PROVIDER_IDS)[number];

export const VoiceConversationProvider = Schema.Literals(VOICE_CONVERSATION_PROVIDER_IDS);
export type VoiceConversationProvider = typeof VoiceConversationProvider.Type;

export const VoiceAssistantMode = Schema.Literals(["off", "push-to-talk", "wake-word"]);
export type VoiceAssistantMode = typeof VoiceAssistantMode.Type;

export const VoiceSilenceTimeoutSeconds = Schema.Literals([5, 10]);
export type VoiceSilenceTimeoutSeconds = typeof VoiceSilenceTimeoutSeconds.Type;

export const VoiceProviderRole = Schema.Literals(["conversation", "decision"]);
export type VoiceProviderRole = typeof VoiceProviderRole.Type;

/** `planned` providers may hold a credential but must read as unavailable. */
export const VoiceProviderImplementation = Schema.Literals(["implemented", "planned"]);
export type VoiceProviderImplementation = typeof VoiceProviderImplementation.Type;

export const VoiceProviderTestStatus = Schema.Literals([
  "never-tested",
  "succeeded",
  "failed",
  "unavailable",
]);
export type VoiceProviderTestStatus = typeof VoiceProviderTestStatus.Type;

export const VoiceProviderTestResult = Schema.Struct({
  status: VoiceProviderTestStatus,
  testedAt: Schema.NullOr(IsoDateTime),
  latencyMs: Schema.NullOr(NonNegativeInt),
  message: Schema.NullOr(Schema.String),
  /** True when the probe actually hit the provider and may bill usage. */
  incurredUsage: Schema.Boolean,
});
export type VoiceProviderTestResult = typeof VoiceProviderTestResult.Type;

export const NEVER_TESTED_PROVIDER_RESULT: VoiceProviderTestResult = {
  status: "never-tested",
  testedAt: null,
  latencyMs: null,
  message: null,
  incurredUsage: false,
};

/** Redacted view of one provider credential. Never carries key material. */
export const VoiceProviderKeyStatus = Schema.Struct({
  providerId: VoiceProviderId,
  role: VoiceProviderRole,
  label: TrimmedNonEmptyString,
  implementation: VoiceProviderImplementation,
  configured: Schema.Boolean,
  /** Non-secret display hint, e.g. the last 4 characters of the key. */
  keyHint: Schema.NullOr(Schema.String),
  configuredAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  lastTest: VoiceProviderTestResult,
  /** Environment-owned secret file name (no secret value). */
  secretName: TrimmedNonEmptyString,
  /** Provider env var name the live adapter would consume. */
  envVarName: TrimmedNonEmptyString,
});
export type VoiceProviderKeyStatus = typeof VoiceProviderKeyStatus.Type;

export const VoiceProviderConfigSnapshot = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  providers: Schema.Array(VoiceProviderKeyStatus),
});
export type VoiceProviderConfigSnapshot = typeof VoiceProviderConfigSnapshot.Type;

export const VoiceProviderGetConfigInput = Schema.Struct({});
export type VoiceProviderGetConfigInput = typeof VoiceProviderGetConfigInput.Type;

export const VoiceProviderSetKeyInput = Schema.Struct({
  providerId: VoiceProviderId,
  apiKey: TrimmedNonEmptyString,
});
export type VoiceProviderSetKeyInput = typeof VoiceProviderSetKeyInput.Type;

export const VoiceProviderRemoveKeyInput = Schema.Struct({
  providerId: VoiceProviderId,
});
export type VoiceProviderRemoveKeyInput = typeof VoiceProviderRemoveKeyInput.Type;

export const VoiceProviderTestKeyInput = Schema.Struct({
  providerId: VoiceProviderId,
  /**
   * When present, probes this candidate key without storing or persisting a
   * result, so a replacement can be validated before it is committed.
   */
  apiKey: Schema.optionalKey(TrimmedNonEmptyString),
});
export type VoiceProviderTestKeyInput = typeof VoiceProviderTestKeyInput.Type;

/**
 * A live session credential for the conversation provider, scoped to one
 * authorized client. `authMode` is explicit so the client can never assume a
 * short-lived token when it actually holds a long-lived key; the server logs
 * and UI can report which mode is in use.
 */
export const VoiceLiveSessionCredential = Schema.Struct({
  provider: VoiceConversationProvider,
  model: TrimmedNonEmptyString,
  authMode: Schema.Literals(["api-key", "ephemeral-token"]),
  token: TrimmedNonEmptyString,
  endpointUrl: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type VoiceLiveSessionCredential = typeof VoiceLiveSessionCredential.Type;

export const VoiceGetLiveSessionCredentialInput = Schema.Struct({
  provider: VoiceConversationProvider,
});
export type VoiceGetLiveSessionCredentialInput = typeof VoiceGetLiveSessionCredentialInput.Type;

export class VoiceProviderConfigError extends Schema.TaggedError<VoiceProviderConfigError>()(
  "VoiceProviderConfigError",
  {
    message: Schema.String,
    providerId: Schema.NullOr(VoiceProviderId),
  },
) {}

export const VOICE_PROVIDER_LABELS: Readonly<Record<VoiceProviderId, string>> = {
  gemini: "Gemini Live",
  openai: "OpenAI voice",
  jev: "Jev / TypeSafe",
};

/** Voice sessions belong to a device, independently of orchestration projects. */
export const VoiceExecutionInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("run"),
    sessionId: TrimmedNonEmptyString,
    requestId: TrimmedNonEmptyString,
    profileId: TrimmedNonEmptyString,
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    action: Schema.Literals(["status", "stop", "close"]),
    sessionId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    sessionId: TrimmedNonEmptyString,
    requestId: TrimmedNonEmptyString,
    answers: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    action: Schema.Literal("respond"),
    sessionId: TrimmedNonEmptyString,
    requestId: TrimmedNonEmptyString,
    approve: Schema.Boolean,
  }),
]);
export type VoiceExecutionInput = typeof VoiceExecutionInput.Type;

export const VoiceExecutionSnapshot = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  status: Schema.Literals([
    "idle",
    "running",
    "completed",
    "failed",
    "stopped",
    "approval",
    "input",
  ]),
  text: Schema.String,
  pendingRequest: Schema.NullOr(
    Schema.Struct({
      requestId: TrimmedNonEmptyString,
      description: Schema.String,
      questions: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type VoiceExecutionSnapshot = typeof VoiceExecutionSnapshot.Type;

export class VoiceExecutionError extends Schema.TaggedError<VoiceExecutionError>()(
  "VoiceExecutionError",
  { message: Schema.String },
) {}
