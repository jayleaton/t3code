import type { VoiceProviderId, VoiceProviderTestResult } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { VOICE_PROVIDER_SPECS } from "./voiceProviderSpecs.ts";

const PROBE_TIMEOUT_MS = 12_000;
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";
const TYPESAFE_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";

export interface VoiceProviderProbeInput {
  readonly providerId: VoiceProviderId;
  readonly apiKey: string;
}

/**
 * Talks to the provider to validate a credential. Kept behind an injectable
 * service so tests can prove save/replace/test/remove without real keys or
 * network, while the live server uses the real endpoints below. Probes must
 * never mutate agent state; the only side effect is provider usage, disclosed
 * on the returned result.
 */
export class VoiceProviderProbe extends Context.Service<
  VoiceProviderProbe,
  {
    readonly probe: (input: VoiceProviderProbeInput) => Effect.Effect<VoiceProviderTestResult>;
  }
>()("t3/voice/VoiceProviderProbe") {}

const result = (
  status: VoiceProviderTestResult["status"],
  message: string | null,
  incurredUsage: boolean,
  testedAt: string,
  latencyMs: number,
): VoiceProviderTestResult => ({ status, testedAt, latencyMs, message, incurredUsage });

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const probeGemini = Effect.fn("VoiceProviderProbe.gemini")(function* (apiKey: string) {
    const started = yield* Clock.currentTimeMillis;
    const response = yield* client
      .execute(
        HttpClientRequest.get(GEMINI_MODELS_URL).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", apiKey),
        ),
      )
      .pipe(
        Effect.timeout(PROBE_TIMEOUT_MS),
        Effect.catch(() => Effect.succeed(null)),
      );
    const finished = yield* Clock.currentTimeMillis;
    const testedAt = DateTime.formatIso(yield* DateTime.now);
    const latencyMs = Math.max(0, Math.round(finished - started));

    if (response === null) {
      return result("failed", "Could not reach the Gemini API.", false, testedAt, latencyMs);
    }
    if (response.status >= 200 && response.status < 300) {
      return result("succeeded", "Gemini API key validated.", false, testedAt, latencyMs);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return result("failed", "Gemini rejected the API key.", false, testedAt, latencyMs);
    }
    return result("failed", `Gemini returned HTTP ${response.status}.`, false, testedAt, latencyMs);
  });

  /**
   * Jev has no unauthenticated health endpoint, so the cheapest real check is a
   * single trivial Noul question. That does incur a small amount of usage.
   */
  const probeJev = Effect.fn("VoiceProviderProbe.jev")(function* (apiKey: string) {
    const started = yield* Clock.currentTimeMillis;
    const response = yield* client
      .execute(
        HttpClientRequest.post(TYPESAFE_SYSTEMONE_URL).pipe(
          HttpClientRequest.bearerToken(apiKey),
          HttpClientRequest.bodyJsonUnsafe({
            state: "connection check",
            model: "jev-latest",
            questions: {
              reachable: {
                type: "noul",
                instructions: "Does this state contain the words connection check?",
              },
            },
          }),
        ),
      )
      .pipe(
        Effect.timeout(PROBE_TIMEOUT_MS),
        Effect.catch(() => Effect.succeed(null)),
      );
    const finished = yield* Clock.currentTimeMillis;
    const testedAt = DateTime.formatIso(yield* DateTime.now);
    const latencyMs = Math.max(0, Math.round(finished - started));

    if (response === null) {
      return result("failed", "Could not reach the TypeSafe API.", true, testedAt, latencyMs);
    }
    if (response.status >= 200 && response.status < 300) {
      return result(
        "succeeded",
        "Jev API key validated. This test used a small amount of TypeSafe usage.",
        true,
        testedAt,
        latencyMs,
      );
    }
    if (response.status === 401 || response.status === 403) {
      return result("failed", "TypeSafe rejected the API key.", false, testedAt, latencyMs);
    }
    return result(
      "failed",
      `TypeSafe returned HTTP ${response.status}.`,
      false,
      testedAt,
      latencyMs,
    );
  });

  const probe = Effect.fn("VoiceProviderProbe.probe")(function* (input: VoiceProviderProbeInput) {
    const spec = VOICE_PROVIDER_SPECS[input.providerId];
    if (spec.implementation === "planned") {
      return result(
        "unavailable",
        `${spec.label} is not implemented yet, so its key was stored but not tested.`,
        false,
        DateTime.formatIso(yield* DateTime.now),
        0,
      );
    }
    if (input.providerId === "jev") {
      return yield* probeJev(input.apiKey);
    }
    return yield* probeGemini(input.apiKey);
  });

  return VoiceProviderProbe.of({ probe });
});

export const layer = Layer.effect(VoiceProviderProbe, make);
