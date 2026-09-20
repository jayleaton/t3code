import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { collectCommandCode } from "../commandCodeProcess.ts";
import { CommandCodeDriver } from "./CommandCodeDriver.ts";

vi.mock("../commandCodeProcess.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commandCodeProcess.ts")>()),
  collectCommandCode: vi.fn(),
}));
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-commandcode-catalog-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);
const input = {
  instanceId: ProviderInstanceId.make("commandcode-test"),
  displayName: "Command Code",
  environment: [],
  enabled: true,
  config: CommandCodeDriver.defaultConfig(),
};

it.layer(layer)("Command Code catalog health", (it) => {
  it.effect("a model catalog timeout preserves authenticated status and the last catalog", () =>
    Effect.gen(function* () {
      const catalogStarted = yield* Deferred.make<void>();
      let hanging = false;
      vi.mocked(collectCommandCode).mockImplementation(({ args }) => {
        if (args.includes("--version"))
          return Effect.succeed({ code: 0, stdout: "1.58.0", stderr: "" });
        if (args.includes("status"))
          return Effect.succeed({ code: 0, stdout: '{"authenticated":true}', stderr: "" });
        return hanging
          ? Deferred.succeed(catalogStarted, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed({ code: 0, stdout: "gpt-6-astra  Coding", stderr: "" });
      });
      const driver = yield* CommandCodeDriver.create(input);
      const before = Option.getOrThrow(yield* driver.snapshot.streamChanges.pipe(Stream.runHead));
      expect(before.models.map((m) => m.slug)).toContain("gpt-6-astra");
      hanging = true;
      const refresh = yield* driver.snapshot.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(catalogStarted);
      yield* TestClock.adjust("15 seconds");
      const after = yield* Fiber.join(refresh);
      expect(after).toMatchObject({
        installed: true,
        version: "1.58.0",
        status: "ready",
        auth: { status: "authenticated" },
      });
      expect(after.models).toEqual(before.models);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  for (const authenticated of [true, false]) {
    it.effect(`catalog failure at startup preserves auth=${authenticated}`, () =>
      Effect.gen(function* () {
        vi.mocked(collectCommandCode).mockImplementation(({ args }) =>
          Effect.succeed(
            args.includes("--version")
              ? { code: 0, stdout: "1.58.0", stderr: "" }
              : args.includes("status")
                ? {
                    code: authenticated ? 0 : 1,
                    stdout: JSON.stringify({ authenticated }),
                    stderr: "",
                  }
                : { code: 1, stdout: "", stderr: "Catalog unavailable" },
          ),
        );
        const driver = yield* CommandCodeDriver.create(input);
        expect(yield* driver.snapshot.refresh).toMatchObject({
          installed: true,
          status: authenticated ? "ready" : "error",
          auth: { status: authenticated ? "authenticated" : "unauthenticated" },
          models: [{ slug: "default" }],
        });
      }).pipe(Effect.scoped),
    );
  }
});
