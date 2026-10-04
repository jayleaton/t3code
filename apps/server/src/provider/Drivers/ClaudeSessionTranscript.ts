// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

const pathKind = (target: string): Promise<"directory" | "file" | "missing" | "unknown"> =>
  NodeFSP.stat(target).then(
    (stats) => (stats.isDirectory() ? "directory" : "file"),
    (cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT" || cause.code === "ENOTDIR" ? "missing" : "unknown",
  );

/**
 * Whether Claude's session storage under `configDir` holds a transcript for
 * `sessionId`, which is what `--resume <id>` needs to succeed.
 *
 * The CLI files each transcript as `projects/<encoded cwd>/<id>.jsonl`. The
 * cwd encoding differs by platform and CLI version (drive letters, Windows
 * separators, long-path hashing), so every project directory is searched
 * rather than re-deriving it. Session ids are UUIDs, so a hit in any project
 * is this session.
 *
 * Returns `undefined` when the answer is unknown (no config dir, or storage
 * that cannot be read), so callers keep their previous assumption instead of
 * discarding a session they simply cannot see.
 */
export const claudeSessionTranscriptExists = (input: {
  readonly configDir: string;
  readonly sessionId: string;
}): Effect.Effect<boolean | undefined> =>
  Effect.promise(async () => {
    if (input.sessionId.length === 0 || /[\\/]|\.\./.test(input.sessionId)) return undefined;
    if ((await pathKind(input.configDir)) !== "directory") return undefined;
    const projectsDir = NodePath.join(input.configDir, "projects");
    const projectsKind = await pathKind(projectsDir);
    // A readable config dir without projects has never stored a session.
    if (projectsKind === "missing") return false;
    if (projectsKind !== "directory") return undefined;
    const projects = await NodeFSP.readdir(projectsDir).catch(() => undefined);
    if (projects === undefined) return undefined;
    const fileName = `${input.sessionId}.jsonl`;
    const kinds = await Promise.all(
      projects.map((project) => pathKind(NodePath.join(projectsDir, project, fileName))),
    );
    return kinds.includes("file");
  });
