import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandCodeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { makeCommandCodeTextGeneration } from "./CommandCodeTextGeneration.ts";

const decodeSettings = Schema.decodeUnknownEffect(CommandCodeSettings);

it.effect("generates titles in a non-persistent read-only CLI session", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-commandcode-text-" });
    const binaryPath = yield* Effect.sync(() =>
      writeFakeCli({
        directory: cwd,
        name: "commandcode",
        source: `
    const args = process.argv.slice(2);
    if(!['--plan','--no-session','--no-auto-update'].every(flag => args.includes(flag)) || args.includes('--yolo')) process.exit(2);
    let prompt = ''; for await(const chunk of process.stdin) prompt += chunk;
    if(!prompt.includes('Fix search')) process.exit(3);
    console.log(JSON.stringify({title:'Fix search',needsRefinement:false}));
  `,
      }),
    );
    const settings = yield* decodeSettings({ binaryPath });
    const generation = yield* makeCommandCodeTextGeneration(settings, process.env);
    assert.deepEqual(
      yield* generation.generateThreadTitle({
        cwd,
        message: "Fix search",
        modelSelection: { instanceId: ProviderInstanceId.make("commandcode"), model: "default" },
      }),
      { title: "Fix search" },
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
