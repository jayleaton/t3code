import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeSessionTranscriptExists } from "./ClaudeSessionTranscript.ts";

const SESSION_ID = "9b7e437e-6b0e-4d18-bdf4-dca34e6572b0";

describe("claudeSessionTranscriptExists", () => {
  it.effect("finds a transcript under any encoded project directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      // A Windows cwd as the CLI encodes it.
      const project = path.join(configDir, "projects", "C--Users-me-code-app");
      yield* fileSystem.makeDirectory(project, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(configDir, "projects", "-tmp-other"));
      yield* fileSystem.writeFileString(path.join(project, `${SESSION_ID}.jsonl`), "{}\n");

      assert.equal(
        yield* claudeSessionTranscriptExists({ configDir, sessionId: SESSION_ID }),
        true,
      );
      assert.equal(
        yield* claudeSessionTranscriptExists({ configDir, sessionId: "13aeed5e-0000" }),
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports no session for a config dir that never stored one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      assert.equal(
        yield* claudeSessionTranscriptExists({ configDir, sessionId: SESSION_ID }),
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cannot tell when the config dir is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      assert.equal(
        yield* claudeSessionTranscriptExists({
          configDir: path.join(parent, "missing"),
          sessionId: SESSION_ID,
        }),
        undefined,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
