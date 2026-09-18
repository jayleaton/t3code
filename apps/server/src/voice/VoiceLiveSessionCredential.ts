import {
  VoiceProviderConfigError,
  type VoiceGetLiveSessionCredentialInput,
  type VoiceLiveSessionCredential,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { VOICE_PROVIDER_SPECS } from "./voiceProviderSpecs.ts";

const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Live model id. `gemini-3.8-live` is the non-extended-thinking Live model and
 * does not accept `thinking_level`, so the session setup omits any thinking
 * config. Overridable so a model rename does not need a code change.
 */
const resolveGeminiLiveModel = (): string => {
  const override = process.env.T3CODE_GEMINI_LIVE_MODEL?.trim();
  return override && override.length > 0 ? override : "gemini-3.8-live";
};

/**
 * Hands an authorized client what it needs to open a live voice session.
 *
 * Interim: this returns the stored API key directly. That is acceptable only
 * because the caller is a paired, operate-scoped client of the environment
 * that already owns the key and the feature is explicitly enabled. The
 * follow-up is a Gemini ephemeral token (authMode "ephemeral-token"), at which
 * point the raw key never leaves this process; the contract already carries
 * that distinction so clients do not change.
 */
export class VoiceLiveSessionCredentialService extends Context.Service<
  VoiceLiveSessionCredentialService,
  {
    readonly get: (
      input: VoiceGetLiveSessionCredentialInput,
    ) => Effect.Effect<VoiceLiveSessionCredential, VoiceProviderConfigError>;
  }
>()("t3/voice/VoiceLiveSessionCredential/VoiceLiveSessionCredentialService") {}

const decoder = new TextDecoder();

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;

  const get = Effect.fn("VoiceLiveSessionCredential.get")(function* (
    input: VoiceGetLiveSessionCredentialInput,
  ) {
    if (input.provider !== "gemini") {
      return yield* new VoiceProviderConfigError({
        providerId: "openai",
        message: "OpenAI voice is not implemented yet.",
      });
    }
    const spec = VOICE_PROVIDER_SPECS.gemini;
    const stored = yield* store.get(spec.secretName).pipe(
      Effect.mapError(
        () =>
          new VoiceProviderConfigError({
            providerId: "gemini",
            message: "Could not read the Gemini API key from this environment's secret store.",
          }),
      ),
    );
    if (Option.isNone(stored)) {
      return yield* new VoiceProviderConfigError({
        providerId: "gemini",
        message:
          "No Gemini API key is configured in this environment. Add one in Settings, Voice assistant.",
      });
    }
    return {
      provider: "gemini",
      model: resolveGeminiLiveModel(),
      authMode: "api-key",
      token: decoder.decode(stored.value),
      endpointUrl: GEMINI_LIVE_ENDPOINT,
      expiresAt: null,
    } satisfies VoiceLiveSessionCredential;
  });

  return VoiceLiveSessionCredentialService.of({ get });
});

export const layer = Layer.effect(VoiceLiveSessionCredentialService, make);
