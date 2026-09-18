import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceLiveSessionCredential from "./VoiceLiveSessionCredential.ts";
import { VOICE_PROVIDER_SPECS } from "./voiceProviderSpecs.ts";

const makeLayer = () => {
  const storeLayer = ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-live-test-" })),
  );
  return Layer.mergeAll(
    VoiceLiveSessionCredential.layer.pipe(Layer.provide(storeLayer)),
    storeLayer,
  );
};

const encode = (value: string) => new TextEncoder().encode(value);

it.layer(NodeServices.layer)("VoiceLiveSessionCredential", (it) => {
  it.effect("returns the stored Gemini key with an explicit auth mode", () =>
    Effect.gen(function* () {
      const service = yield* VoiceLiveSessionCredential.VoiceLiveSessionCredentialService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      yield* store.set(VOICE_PROVIDER_SPECS.gemini.secretName, encode("gemini-secret-key-1234"));

      const credential = yield* service.get({ provider: "gemini" });

      assert.equal(credential.provider, "gemini");
      assert.equal(credential.authMode, "api-key");
      assert.equal(credential.token, "gemini-secret-key-1234");
      assert.equal(credential.expiresAt, null);
      assert.include(credential.endpointUrl, "BidiGenerateContent");
      assert.isAbove(credential.model.length, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("fails actionably when no Gemini key is configured", () =>
    Effect.gen(function* () {
      const service = yield* VoiceLiveSessionCredential.VoiceLiveSessionCredentialService;

      const error = yield* Effect.flip(service.get({ provider: "gemini" }));

      assert.equal(error.providerId, "gemini");
      assert.include(error.message, "No Gemini API key is configured");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses to mint an unimplemented provider credential without leaking its key", () =>
    Effect.gen(function* () {
      const service = yield* VoiceLiveSessionCredential.VoiceLiveSessionCredentialService;
      const store = yield* ServerSecretStore.ServerSecretStore;
      yield* store.set(
        VOICE_PROVIDER_SPECS.openai.secretName,
        encode("openai-key-should-not-leak"),
      );

      const error = yield* Effect.flip(service.get({ provider: "openai" }));

      assert.include(error.message, "not implemented yet");
      assert.notInclude(error.message, "openai-key-should-not-leak");
    }).pipe(Effect.provide(makeLayer())),
  );
});
