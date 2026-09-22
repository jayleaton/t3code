import { AgentSkill } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  syncAgentSkillFiles,
  syncAgentInstructionFile,
  agentInstructionRelativePath,
} from "./AgentInstructionFiles.ts";

const encodeSkillSnapshot = Schema.encodeEffect(Schema.fromJsonString(AgentSkill));
const decodeSkillSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentSkill));

it.effect(
  "isolates concurrent chats, cleans only the settled chat, and restores its frozen prompt",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const first = { cwd, threadId: "chat-one", instructions: "Plan carefully.", settled: false };
      const second = { ...first, threadId: "chat-two", instructions: "Write code." };
      yield* Effect.all([syncAgentInstructionFile(first), syncAgentInstructionFile(second)], {
        concurrency: 2,
      });
      const firstPath = path.join(cwd, agentInstructionRelativePath(first.threadId));
      const secondPath = path.join(cwd, agentInstructionRelativePath(second.threadId));
      yield* fs.writeFileString(path.join(cwd, ".agents", "notes.md"), "Keep this user file.");
      yield* syncAgentInstructionFile({ ...first, settled: true });
      assert.isFalse(yield* fs.exists(firstPath));
      assert.isTrue(yield* fs.exists(secondPath));
      assert.equal(
        yield* fs.readFileString(path.join(cwd, ".agents", "notes.md")),
        "Keep this user file.",
      );
      yield* syncAgentInstructionFile(first);
      assert.include(yield* fs.readFileString(firstPath), "Plan carefully.");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refreshes a managed prompt and clears removed instructions on next use", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const input = { cwd, threadId: "randy", instructions: "Old review rules", settled: false };
    yield* syncAgentInstructionFile(input);
    yield* syncAgentInstructionFile({ ...input, instructions: "New review rules" });
    const file = path.join(cwd, agentInstructionRelativePath(input.threadId));
    assert.include(yield* fs.readFileString(file), "New review rules");
    assert.notInclude(yield* fs.readFileString(file), "Old review rules");
    yield* syncAgentInstructionFile({ ...input, instructions: "" });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "materializes portable nested bundles with exact bytes and modes in independent environments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const local = yield* fs.makeTempDirectoryScoped();
      const remote = yield* fs.makeTempDirectoryScoped();
      const skill = {
        skillId: "nested",
        name: "Nested",
        description: "Read only needed references",
        content: "# Task\nRead references/deep/rules.md; run scripts/check.sh.",
        revision: 1,
        createdAt: "2026-09-22",
        updatedAt: "2026-09-22",
        resources: [
          {
            path: "references/deep/rules.md",
            contentBase64: Buffer.from("Exact UTF-8: café\n").toString("base64"),
          },
          {
            path: "scripts/check.sh",
            contentBase64: Buffer.from("#!/bin/sh\nprintf ok\n").toString("base64"),
            executable: true,
          },
          { path: "assets/pixel.bin", contentBase64: "AP+A/w==" },
        ],
      };
      const snapshot = yield* decodeSkillSnapshot(yield* encodeSkillSnapshot(skill));
      const bundle = (index: string) => index.match(/file: ([^)]+)\)/)![1]!;
      for (const cwd of [local, remote]) {
        const index = yield* syncAgentSkillFiles({ cwd, threadId: "thread", skills: [snapshot] });
        const directory = path.dirname(path.join(cwd, bundle(index)));
        assert.notInclude(index, "café");
        for (const file of skill.resources) {
          const actual = path.join(directory, file.path);
          assert.deepEqual(
            Buffer.from(yield* fs.readFile(actual)),
            Buffer.from(file.contentBase64, "base64"),
          );
          assert.equal((yield* fs.stat(actual)).mode & 0o777, "executable" in file ? 0o700 : 0o600);
        }
        yield* syncAgentSkillFiles({ cwd, threadId: "thread", skills: [snapshot] });
        const updated = yield* syncAgentSkillFiles({
          cwd,
          threadId: "new-thread",
          skills: [{ ...snapshot, resources: [] }],
        });
        assert.isFalse(
          yield* fs.exists(
            path.join(path.dirname(path.join(cwd, bundle(updated))), "scripts/check.sh"),
          ),
        );
        assert.isTrue(yield* fs.exists(path.join(directory, "scripts/check.sh")));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects resource traversal and links without changing files outside the bundle", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const skill = {
      skillId: "test",
      name: "Test",
      description: "Test",
      content: "# Test",
      revision: 1,
      createdAt: "now",
      updatedAt: "now",
      resources: [{ path: "nested/file", contentBase64: "b2s=" }],
    };
    const index = yield* syncAgentSkillFiles({ cwd, threadId: "thread", skills: [skill] });
    const file = path.join(cwd, path.dirname(index.match(/file: ([^)]+)\)/)![1]!), "nested/file");
    const outside = path.join(cwd, "outside");
    yield* fs.writeFileString(outside, "untouched");
    yield* fs.remove(file);
    yield* fs.symlink(outside, file);
    const result = yield* Effect.exit(
      syncAgentSkillFiles({ cwd, threadId: "thread", skills: [skill] }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(yield* fs.readFileString(outside), "untouched");
    const invalid = yield* Effect.exit(
      syncAgentSkillFiles({
        cwd,
        threadId: "invalid",
        skills: [{ ...skill, resources: [{ path: "../escape", contentBase64: "b2s=" }] }],
      }),
    );
    assert.equal(invalid._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
