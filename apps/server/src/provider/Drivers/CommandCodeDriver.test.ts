import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { layer as idAllocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { CommandCodeDriver } from "./CommandCodeDriver.ts";

const layer = layerTestProviderHost({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(idAllocatorLayer),
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

  it.effect.each([true, false])("probes auth=%s and publishes selectable models", (authenticated) =>
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
