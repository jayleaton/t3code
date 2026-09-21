import type { AgentSkill } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
// @effect-diagnostics nodeBuiltinImport:off -- FileSystem.remove uses rm; native rmdir is needed to refuse deletion if a directory becomes nonempty.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

class AgentInstructionFileError extends Schema.TaggedError<AgentInstructionFileError>()(
  "AgentInstructionFileError",
  { message: Schema.String },
) {}

export function agentInstructionRelativePath(threadId: string): string {
  const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
  return `.agents/t3/${key}/AGENT.md`;
}

// A chat owns one generated file, never a project-wide AGENTS.md or another chat's directory.
const syncManagedInstructionFile = Effect.fn("syncManagedInstructionFile")(function* (input: {
  relativePath: string;
  cwd: string;
  threadId: string;
  instructions: string;
  settled: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(input.cwd);
  const relativePath = input.relativePath;
  const segments = relativePath.split("/");
  const marker = `<!-- T3 managed instructions: ${segments[2]} -->`;
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    if (!(yield* fs.exists(parent))) {
      if (input.settled || !input.instructions.trim()) return;
      yield* fs.makeDirectory(parent, { recursive: true });
    }
    const actual = yield* fs.realPath(parent);
    if (actual !== parent)
      return yield* Effect.fail(
        new AgentInstructionFileError({
          message: "Agent instruction directories must not be symlinks.",
        }),
      );
  }
  if (!input.settled) {
    // This directory holds runtime material, not changes the coding agent should commit.
    yield* fs
      .writeFileString(path.join(root, ".agents", "t3", ".gitignore"), "*\n", { flag: "wx" })
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }
  const file = path.join(root, relativePath);
  if (yield* fs.exists(file)) {
    if ((yield* fs.realPath(file)) !== file)
      return yield* Effect.fail(
        new AgentInstructionFileError({ message: "Agent instruction file must not be a symlink." }),
      );
    const previous = yield* fs.readFileString(file);
    if (!previous.startsWith(`${marker}\n`))
      return yield* Effect.fail(
        new AgentInstructionFileError({
          message: "Refusing to replace an unmanaged agent instruction file.",
        }),
      );
    if (input.settled || !input.instructions.trim()) {
      yield* fs.remove(file);
      // Preserve handoff documents and any user-added files. Only remove empty directories.
      for (const directory of [parent, path.dirname(parent), path.dirname(path.dirname(parent))]) {
        if (!(yield* fs.exists(directory)) || (yield* fs.readDirectory(directory)).length !== 0)
          break;
        yield* Effect.tryPromise(() => NodeFSP.rmdir(directory));
      }
    } else {
      const next = `${marker}\n\n${input.instructions.trim()}\n`;
      if (previous !== next) yield* fs.writeFileString(file, next);
    }
    return;
  }
  if (!input.settled && input.instructions.trim()) {
    yield* fs.writeFileString(file, `${marker}\n\n${input.instructions.trim()}\n`, { flag: "wx" });
  }
});

export const syncAgentInstructionFile = (input: {
  cwd: string;
  threadId: string;
  instructions: string;
  settled: boolean;
}) =>
  syncManagedInstructionFile({
    ...input,
    relativePath: agentInstructionRelativePath(input.threadId),
  });

/** Skills are private to this thread; native/provider-owned skill directories stay independent. */
export const syncAgentSkillFiles = Effect.fn("syncAgentSkillFiles")(function* (input: {
  cwd: string;
  threadId: string;
  skills: ReadonlyArray<AgentSkill>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = agentInstructionRelativePath(input.threadId).replace(/AGENT\.md$/, "skills");
  const assigned = new Set<string>();
  const entries: string[] = [];
  for (const skill of input.skills) {
    const key = NodeCrypto.createHash("sha256").update(skill.skillId).digest("hex");
    assigned.add(key);
    const relativePath = `${root}/${key}/SKILL.md`;
    yield* syncManagedInstructionFile({
      ...input,
      instructions: skill.content,
      settled: false,
      relativePath,
    });
    const digest = NodeCrypto.createHash("sha256").update(skill.content).digest("hex").slice(0, 16);
    entries.push(
      `- ${quote(skill.name)}: ${quote(skill.description)} (revision ${skill.revision}, updated ${skill.updatedAt}, content ${digest}, file: ${relativePath})`,
    );
  }
  const directory = path.join(input.cwd, root);
  if (yield* fs.exists(directory)) {
    if ((yield* fs.realPath(directory)) !== path.join(yield* fs.realPath(input.cwd), root))
      return yield* new AgentInstructionFileError({
        message: "Agent skill directory must not be a symlink.",
      });
    for (const key of yield* fs.readDirectory(directory)) {
      if (!/^[a-f0-9]{64}$/.test(key) || assigned.has(key)) continue;
      yield* syncManagedInstructionFile({
        ...input,
        instructions: "",
        settled: true,
        relativePath: `${root}/${key}/SKILL.md`,
      });
    }
  }
  return entries.length === 0
    ? ""
    : `# Assigned T3 skills\n\nRead the SKILL.md file for each relevant skill before using it. These are the current assignments; previous skill assignments are superseded.\n\n${entries.join("\n")}`;
});
