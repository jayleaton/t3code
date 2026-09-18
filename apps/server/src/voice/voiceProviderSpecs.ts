import type {
  VoiceProviderId,
  VoiceProviderImplementation,
  VoiceProviderRole,
} from "@t3tools/contracts";

/**
 * One place to look up where a voice provider's credential lives and how the
 * live adapter would consume it. `envVarName` is documentation for the UI and
 * for adapters; the value itself is only ever read from the secret store.
 */
export interface VoiceProviderSpec {
  readonly providerId: VoiceProviderId;
  readonly role: VoiceProviderRole;
  readonly label: string;
  readonly implementation: VoiceProviderImplementation;
  /** Environment-owned secret file base name (no extension). */
  readonly secretName: string;
  readonly metaSecretName: string;
  readonly envVarName: string;
}

export const VOICE_PROVIDER_SPECS: Readonly<Record<VoiceProviderId, VoiceProviderSpec>> = {
  gemini: {
    providerId: "gemini",
    role: "conversation",
    label: "Gemini Live",
    implementation: "implemented",
    secretName: "voice-gemini-api-key",
    metaSecretName: "voice-gemini-api-key-meta",
    envVarName: "GEMINI_API_KEY",
  },
  openai: {
    providerId: "openai",
    role: "conversation",
    label: "OpenAI voice",
    implementation: "planned",
    secretName: "voice-openai-api-key",
    metaSecretName: "voice-openai-api-key-meta",
    envVarName: "OPENAI_API_KEY",
  },
  jev: {
    providerId: "jev",
    role: "decision",
    label: "Jev / TypeSafe",
    implementation: "implemented",
    secretName: "voice-jev-api-key",
    metaSecretName: "voice-jev-api-key-meta",
    envVarName: "TYPESAFE_API_KEY",
  },
};

export const VOICE_PROVIDER_ORDER: ReadonlyArray<VoiceProviderId> = ["gemini", "openai", "jev"];
