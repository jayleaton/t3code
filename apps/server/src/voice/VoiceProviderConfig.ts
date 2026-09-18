import {
  NEVER_TESTED_PROVIDER_RESULT,
  VoiceProviderConfigError,
  type VoiceProviderId,
  type VoiceProviderKeyStatus,
  type VoiceProviderRemoveKeyInput,
  type VoiceProviderSetKeyInput,
  type VoiceProviderTestKeyInput,
  VoiceProviderTestResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { VOICE_PROVIDER_ORDER, VOICE_PROVIDER_SPECS } from "./voiceProviderSpecs.ts";
import * as VoiceProviderProbeModule from "./VoiceProviderProbe.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VoiceProviderKeyMeta = Schema.Struct({
  keyHint: Schema.String,
  configuredAt: Schema.String,
  updatedAt: Schema.String,
  lastTest: Schema.optional(VoiceProviderTestResult),
});
type VoiceProviderKeyMeta = typeof VoiceProviderKeyMeta.Type;

const VoiceProviderKeyMetaJson = Schema.fromJsonString(VoiceProviderKeyMeta);
const encodeMetaJson = Schema.encodeSync(VoiceProviderKeyMetaJson);
const decodeMetaJson = Schema.decodeUnknownSync(VoiceProviderKeyMetaJson);

const keyHintFor = (apiKey: string): string =>
  apiKey.length <= 4 ? "*".repeat(apiKey.length) : `...${apiKey.slice(-4)}`;

const readMeta = (
  store: ServerSecretStore.ServerSecretStore["Service"],
  metaSecretName: string,
): Effect.Effect<Option.Option<VoiceProviderKeyMeta>, ServerSecretStore.SecretStoreError> =>
  store.get(metaSecretName).pipe(
    Effect.map((option) => {
      if (Option.isNone(option)) {
        return Option.none<VoiceProviderKeyMeta>();
      }
      try {
        return Option.some(decodeMetaJson(decoder.decode(option.value)));
      } catch {
        // A malformed metadata blob must not hide a configured key.
        return Option.none<VoiceProviderKeyMeta>();
      }
    }),
  );

const writeMeta = (
  store: ServerSecretStore.ServerSecretStore["Service"],
  metaSecretName: string,
  meta: VoiceProviderKeyMeta,
): Effect.Effect<void, ServerSecretStore.SecretStoreError> =>
  store.set(metaSecretName, encoder.encode(encodeMetaJson(meta)));

export class VoiceProviderConfig extends Context.Service<
  VoiceProviderConfig,
  {
    readonly getStatuses: () => Effect.Effect<
      ReadonlyArray<VoiceProviderKeyStatus>,
      VoiceProviderConfigError
    >;
    readonly setKey: (
      input: VoiceProviderSetKeyInput,
    ) => Effect.Effect<ReadonlyArray<VoiceProviderKeyStatus>, VoiceProviderConfigError>;
    readonly removeKey: (
      input: VoiceProviderRemoveKeyInput,
    ) => Effect.Effect<ReadonlyArray<VoiceProviderKeyStatus>, VoiceProviderConfigError>;
    readonly testKey: (
      input: VoiceProviderTestKeyInput,
    ) => Effect.Effect<ReadonlyArray<VoiceProviderKeyStatus>, VoiceProviderConfigError>;
  }
>()("t3/voice/VoiceProviderConfig") {}

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const probe = yield* VoiceProviderProbeModule.VoiceProviderProbe;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const fail = (providerId: VoiceProviderId | null, message: string) =>
    new VoiceProviderConfigError({ message, providerId });

  const statusFor = (
    providerId: VoiceProviderId,
    configured: boolean,
    meta: Option.Option<VoiceProviderKeyMeta>,
  ): VoiceProviderKeyStatus => {
    const spec = VOICE_PROVIDER_SPECS[providerId];
    const value = Option.getOrUndefined(meta);
    return {
      providerId,
      role: spec.role,
      label: spec.label,
      implementation: spec.implementation,
      configured,
      keyHint: configured ? (value?.keyHint ?? null) : null,
      configuredAt: configured ? (value?.configuredAt ?? null) : null,
      updatedAt: configured ? (value?.updatedAt ?? null) : null,
      lastTest: value?.lastTest ?? NEVER_TESTED_PROVIDER_RESULT,
      secretName: spec.secretName,
      envVarName: spec.envVarName,
    };
  };

  const snapshot = Effect.fn("VoiceProviderConfig.snapshot")(function* () {
    return yield* Effect.forEach(
      VOICE_PROVIDER_ORDER,
      (providerId) => {
        const spec = VOICE_PROVIDER_SPECS[providerId];
        return Effect.all({
          key: store.get(spec.secretName),
          meta: readMeta(store, spec.metaSecretName),
        }).pipe(Effect.map(({ key, meta }) => statusFor(providerId, Option.isSome(key), meta)));
      },
      { concurrency: "unbounded" },
    );
  });

  const mapSecretStoreFailure = (providerId: VoiceProviderId | null) => (cause: unknown) =>
    fail(providerId, `Voice provider credential operation failed: ${String(cause)}`);

  const guarded = <A>(
    effect: Effect.Effect<A, ServerSecretStore.SecretStoreError | VoiceProviderConfigError>,
    providerId: VoiceProviderId | null,
  ): Effect.Effect<A, VoiceProviderConfigError> =>
    effect.pipe(
      Effect.catchIf(ServerSecretStore.isSecretStoreError, (cause) =>
        Effect.fail(mapSecretStoreFailure(providerId)(cause)),
      ),
    );

  const getStatuses = () => guarded(snapshot(), null);

  const setKey = Effect.fn("VoiceProviderConfig.setKey")(function* (
    input: VoiceProviderSetKeyInput,
  ) {
    const spec = VOICE_PROVIDER_SPECS[input.providerId];
    const existing = yield* readMeta(store, spec.metaSecretName).pipe(Effect.orDie);
    const timestamp = yield* nowIso;
    yield* store.set(spec.secretName, encoder.encode(input.apiKey));
    yield* writeMeta(store, spec.metaSecretName, {
      keyHint: keyHintFor(input.apiKey),
      configuredAt: Option.match(existing, {
        onNone: () => timestamp,
        onSome: (value) => value.configuredAt,
      }),
      updatedAt: timestamp,
      // A replaced key has not been tested yet; never carry a stale pass over
      // to new key material.
      lastTest: NEVER_TESTED_PROVIDER_RESULT,
    });
    return yield* snapshot();
  });

  const removeKey = Effect.fn("VoiceProviderConfig.removeKey")(function* (
    input: VoiceProviderRemoveKeyInput,
  ) {
    const spec = VOICE_PROVIDER_SPECS[input.providerId];
    yield* store.remove(spec.secretName);
    yield* store.remove(spec.metaSecretName);
    return yield* snapshot();
  });

  const testKey = Effect.fn("VoiceProviderConfig.testKey")(function* (
    input: VoiceProviderTestKeyInput,
  ) {
    const spec = VOICE_PROVIDER_SPECS[input.providerId];
    const existing = yield* readMeta(store, spec.metaSecretName).pipe(Effect.orDie);
    const timestamp = yield* nowIso;

    // A planned provider can hold a key, but must never look testable or
    // functional. Short-circuit before any probe so we cannot accidentally
    // present an unimplemented adapter as working.
    if (spec.implementation === "planned") {
      yield* writeMeta(store, spec.metaSecretName, {
        keyHint: existing._tag === "Some" ? existing.value.keyHint : "",
        configuredAt: existing._tag === "Some" ? existing.value.configuredAt : timestamp,
        updatedAt: timestamp,
        lastTest: {
          status: "unavailable",
          testedAt: timestamp,
          latencyMs: null,
          message: `${spec.label} is not implemented yet, so its key was stored but not tested.`,
          incurredUsage: false,
        },
      });
      return yield* snapshot();
    }

    const key = yield* store.get(spec.secretName);
    if (Option.isNone(key)) {
      return yield* fail(
        input.providerId,
        `No ${spec.label} API key is configured in this environment.`,
      );
    }
    const apiKey = decoder.decode(key.value);
    const lastTest = yield* probe.probe({ providerId: input.providerId, apiKey });
    yield* writeMeta(store, spec.metaSecretName, {
      keyHint: Option.match(existing, {
        onNone: () => keyHintFor(apiKey),
        onSome: (value) => value.keyHint,
      }),
      configuredAt: Option.match(existing, {
        onNone: () => timestamp,
        onSome: (value) => value.configuredAt,
      }),
      updatedAt: timestamp,
      lastTest,
    });
    return yield* snapshot();
  });

  return VoiceProviderConfig.of({
    getStatuses,
    setKey: (input) => guarded(setKey(input), input.providerId),
    removeKey: (input) => guarded(removeKey(input), input.providerId),
    testKey: (input) => guarded(testKey(input), input.providerId),
  });
});

// The probe stays an injected dependency so tests can drive credential
// lifecycle without real keys or network; production provides the real layer.
export const layer = Layer.effect(VoiceProviderConfig, make);
