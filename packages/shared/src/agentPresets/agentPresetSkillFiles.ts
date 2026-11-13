// @effect-diagnostics nodeBuiltinImport:off -- Runs at server build time and in dev, where the skills pool is on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The shipped `skills/<name>/…` pool as text keyed by path under agentPresets/. */
export function readAgentPresetSkillFiles(): Record<string, string> {
  const root = import.meta.dirname;
  return Object.fromEntries(
    NodeFS.readdirSync(NodePath.join(root, "skills"), { recursive: true, withFileTypes: true })
      // Dotfiles are skipped, as the web bundle's glob skips them.
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        const path = NodePath.relative(root, file).split(NodePath.sep).join("/");
        return [path, NodeFS.readFileSync(file, "utf8")] as const;
      }),
  );
}
