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

/** Resume needs projects/<encoded cwd>/<sessionId>.jsonl; encoding varies by platform/version,
 * so search all project directories for the UUID instead of re-deriving the cwd encoding.
 * Return undefined for missing config or unreadable storage so callers retain their assumption. */
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
