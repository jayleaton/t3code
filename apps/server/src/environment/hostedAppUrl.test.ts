import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { hostedAppUrlConfig } from "./hostedAppUrl.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "hosted.example",
      "http://hosted.example",
      "https://hosted.example/nested",
      "https://hosted.example?alias=true",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);
