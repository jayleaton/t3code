import type {
  VoiceProviderId,
  VoiceProviderKeyStatus,
  VoiceProviderTestResult,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VoiceProviderConfig from "./VoiceProviderConfig.ts";
import * as VoiceProviderProbe from "./VoiceProviderProbe.ts";
import { VOICE_PROVIDER_SPECS } from "./voiceProviderSpecs.ts";

const GEMINI_KEY = "gemini-secret-abcdef1234567890abcd";

const testResult = (
  status: VoiceProviderTestResult["status"],
  message: string | null = null,
  incurredUsage = false,
): VoiceProviderTestResult => ({
  status,
  testedAt: "2026-09-18T00:00:00.000Z",
  latencyMs: 12,
  message,
  incurredUsage,
});

const makeConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-provider-test-" });

const makeLayer = (
  probe: (
    input: VoiceProviderProbe.VoiceProviderProbeInput,
  ) => Effect.Effect<VoiceProviderTestResult>,
) => {
  const storeLayer = ServerSecretStore.layer.pipe(Layer.provide(makeConfigLayer()));
  return Layer.mergeAll(
    VoiceProviderConfig.layer.pipe(
      Layer.provide(storeLayer),
      Layer.provide(
        Layer.succeed(
          VoiceProviderProbe.VoiceProviderProbe,
          VoiceProviderProbe.VoiceProviderProbe.of({ probe }),
        ),
      ),
    ),
    // Exposed so tests can assert that raw key material lives only in the
    // environment secret store while status reads stay redacted.
    storeLayer,
  );
};

const findStatus = (
  providers: ReadonlyArray<VoiceProviderKeyStatus>,
  providerId: VoiceProviderId,
) => {
  const status = providers.find((entry) => entry.providerId === providerId);
  if (status === undefined) {
    throw new Error(`Missing provider status for ${providerId}`);
  }
  return status;
};

it.layer(NodeServices.layer)("VoiceProviderConfig", (it) => {
  it.effect("stores a key and reports redacted configured status", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      const providers = yield* config.setKey({ providerId: "gemini", apiKey: GEMINI_KEY });
      const gemini = findStatus(providers, "gemini");

      assert.isTrue(gemini.configured);
      assert.equal(gemini.keyHint, "...abcd");
      assert.equal(gemini.secretName, VOICE_PROVIDER_SPECS.gemini.secretName);
      assert.equal(gemini.envVarName, "GEMINI_API_KEY");
      assert.equal(gemini.lastTest.status, "never-tested");

      // @effect-diagnostics-next-line preferSchemaOverJson:off - asserting redaction of the wire status.
      const serialized = JSON.stringify(providers);
      assert.notInclude(serialized, GEMINI_KEY);
      assert.notInclude(serialized, "apiKey");
      assert.notInclude(serialized, GEMINI_KEY.slice(0, 12));
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(testResult("succeeded"))))),
  );

  it.effect("persists the raw key only in the environment secret store", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;
      const store = yield* ServerSecretStore.ServerSecretStore;

      yield* config.setKey({ providerId: "gemini", apiKey: GEMINI_KEY });

      const stored = yield* store.get(VOICE_PROVIDER_SPECS.gemini.secretName);
      assert.isTrue(stored._tag === "Some");
      if (stored._tag === "Some") {
        assert.equal(new TextDecoder().decode(stored.value), GEMINI_KEY);
      }
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(testResult("succeeded"))))),
  );

  it.effect("validates a key without mutating provider state", () => {
    const probed: VoiceProviderId[] = [];
    return Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      yield* config.setKey({ providerId: "gemini", apiKey: GEMINI_KEY });
      const providers = yield* config.testKey({ providerId: "gemini" });
      const gemini = findStatus(providers, "gemini");

      assert.equal(gemini.lastTest.status, "succeeded");
      assert.deepEqual(probed, ["gemini"]);
    }).pipe(
      Effect.provide(
        makeLayer((input) =>
          Effect.sync(() => probed.push(input.providerId)).pipe(
            Effect.as(testResult("succeeded", "Gemini API key validated.")),
          ),
        ),
      ),
    );
  });

  it.effect("a failed connection test keeps the previously working key", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      yield* config.setKey({ providerId: "gemini", apiKey: GEMINI_KEY });
      const providers = yield* config.testKey({ providerId: "gemini" });
      const gemini = findStatus(providers, "gemini");

      assert.isTrue(gemini.configured);
      assert.equal(gemini.keyHint, "...abcd");
      assert.equal(gemini.lastTest.status, "failed");
      assert.include(gemini.lastTest.message ?? "", "rejected");
    }).pipe(
      Effect.provide(
        makeLayer(() => Effect.succeed(testResult("failed", "Gemini rejected the API key."))),
      ),
    ),
  );

  it.effect("replacing a key resets the test result and updates the hint", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      yield* config.setKey({ providerId: "gemini", apiKey: GEMINI_KEY });
      yield* config.testKey({ providerId: "gemini" });
      const providers = yield* config.setKey({
        providerId: "gemini",
        apiKey: "new-key-wxyz",
      });
      const gemini = findStatus(providers, "gemini");

      assert.isTrue(gemini.configured);
      assert.equal(gemini.keyHint, "...wxyz");
      assert.equal(gemini.lastTest.status, "never-tested");
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(testResult("succeeded"))))),
  );

  it.effect("keeps provider namespaces separate when switching conversation provider", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      yield* config.setKey({ providerId: "gemini", apiKey: GEMINI_KEY });
      yield* config.setKey({ providerId: "openai", apiKey: "openai-key-00001111" });
      const providers = yield* config.getStatuses();

      const gemini = findStatus(providers, "gemini");
      const openai = findStatus(providers, "openai");
      const jev = findStatus(providers, "jev");

      assert.isTrue(gemini.configured);
      assert.isTrue(openai.configured);
      assert.isFalse(jev.configured);
      assert.equal(gemini.keyHint, "...abcd");
      assert.equal(openai.keyHint, "...1111");
      assert.notEqual(gemini.secretName, openai.secretName);
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(testResult("succeeded"))))),
  );

  it.effect("marks the planned OpenAI provider unavailable without probing", () => {
    let probeCalls = 0;
    return Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      yield* config.setKey({ providerId: "openai", apiKey: "openai-key-00001111" });
      const providers = yield* config.testKey({ providerId: "openai" });
      const openai = findStatus(providers, "openai");

      assert.equal(openai.implementation, "planned");
      assert.isTrue(openai.configured);
      assert.equal(openai.lastTest.status, "unavailable");
      assert.isFalse(openai.lastTest.incurredUsage);
      assert.equal(probeCalls, 0);
    }).pipe(
      Effect.provide(
        makeLayer(() =>
          Effect.sync(() => {
            probeCalls += 1;
          }).pipe(Effect.as(testResult("succeeded", "should not run"))),
        ),
      ),
    );
  });

  it.effect("removing a key clears status and secret material", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;
      const store = yield* ServerSecretStore.ServerSecretStore;

      yield* config.setKey({ providerId: "jev", apiKey: "jev-key-99998888" });
      const providers = yield* config.removeKey({ providerId: "jev" });
      const jev = findStatus(providers, "jev");

      assert.isFalse(jev.configured);
      assert.isNull(jev.keyHint);
      assert.equal(jev.lastTest.status, "never-tested");
      assert.isTrue((yield* store.get(VOICE_PROVIDER_SPECS.jev.secretName))._tag === "None");
      assert.isTrue((yield* store.get(VOICE_PROVIDER_SPECS.jev.metaSecretName))._tag === "None");
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(testResult("succeeded"))))),
  );

  it.effect("testing an unconfigured provider fails with an actionable error", () =>
    Effect.gen(function* () {
      const config = yield* VoiceProviderConfig.VoiceProviderConfig;

      const error = yield* Effect.flip(config.testKey({ providerId: "jev" }));

      assert.equal(error.providerId, "jev");
      assert.include(error.message, "No Jev / TypeSafe API key is configured");
    }).pipe(Effect.provide(makeLayer(() => Effect.succeed(testResult("succeeded"))))),
  );
});
