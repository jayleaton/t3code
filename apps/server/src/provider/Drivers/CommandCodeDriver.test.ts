import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { CommandCodeDriver } from "./CommandCodeDriver.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-commandcode-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(idAllocatorLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);
const input = {
  instanceId: ProviderInstanceId.make("commandcode-test"),
  displayName: "My Command Code",
  environment: [],
  enabled: false,
  config: CommandCodeDriver.defaultConfig(),
};
it.layer(layer)("CommandCodeDriver", (it) => {
  it.effect("does not spawn disabled providers", () =>
    Effect.gen(function* () {
      const driver = yield* CommandCodeDriver.create(input);
      expect((yield* driver.snapshot.refresh).status).toBe("disabled");
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Disabled provider spawned a process")),
      ),
      Effect.scoped,
    ),
  );

  for (const authenticated of [true, false]) {
    it.effect(`probes auth=${authenticated} and publishes selectable models`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-commandcode-status-" });
        const binaryPath = yield* Effect.sync(() =>
          writeFakeCli({
            directory: cwd,
            name: "commandcode",
            source: `
        const args = process.argv.slice(2);
        if(args.includes('--version')) console.log('1.58.0');
        else if(args.includes('status')) {console.log(JSON.stringify({authenticated: ${authenticated}})); process.exit(${authenticated ? 0 : 1});}
        else if(args.includes('--list-models')) console.log('Available models  ·  1 model\\n\\nOpenAI\\n\\ngpt-6-astra  Coding');
        else process.exit(2);
      `,
          }),
        );
        const driver = yield* CommandCodeDriver.create({
          ...input,
          enabled: true,
          config: { ...input.config, binaryPath },
        });
        const snapshot = yield* driver.snapshot.refresh;
        expect(snapshot).toMatchObject({
          instanceId: "commandcode-test",
          driver: "commandcode",
          displayName: "My Command Code",
          installed: true,
          version: "1.58.0",
          status: authenticated ? "ready" : "error",
          auth: { status: authenticated ? "authenticated" : "unauthenticated" },
        });
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default", "gpt-6-astra"]);
      }).pipe(Effect.scoped),
    );
  }
  it.effect("reports a missing CLI as unavailable to run", () =>
    Effect.gen(function* () {
      const driver = yield* CommandCodeDriver.create({
        ...input,
        enabled: true,
        config: { ...input.config, binaryPath: "/missing-commandcode-binary" },
      });
      expect(yield* driver.snapshot.refresh).toMatchObject({ installed: false, status: "error" });
    }).pipe(Effect.scoped),
  );
});
