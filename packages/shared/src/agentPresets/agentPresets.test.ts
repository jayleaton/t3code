// @effect-diagnostics nodeBuiltinImport:off -- Reads the fixture and bundled preset folders the way a bundler sees them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { AgentSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { addPresetSkills, decodeAgentPresets, type AgentPresetSkill } from "./agentPresets.ts";

function readTree(root: string, directory: string): Record<string, string> {
  const base = NodePath.join(root, directory);
  if (!NodeFS.existsSync(base)) return {};
  return Object.fromEntries(
    NodeFS.readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        const path = NodePath.relative(root, file).split(NodePath.sep).join("/");
        return [path, NodeFS.readFileSync(file, "utf8")];
      }),
  );
}

const fixtureRoot = NodePath.join(import.meta.dirname, "fixtures");
const fixtures = { ...readTree(fixtureRoot, "presets"), ...readTree(fixtureRoot, "skills") };
const manifest = (overrides: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(fixtures["presets/reviewer/preset.json"]!), ...overrides });

describe("decodeAgentPresets", () => {
  it("decodes a preset folder into profile fields, prompt and skill bundles", () => {
    const [preset] = decodeAgentPresets(fixtures);
    expect(preset).toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      icon: "shield",
      model: { provider: "codex", model: "gpt-5.5", reasoningEffort: "high" },
      runtimeMode: "read-only",
      systemPrompt: "You review code changes. Report correctness bugs first, then missing tests.",
      setupNotes: ["Needs the GitHub CLI (gh) signed in to read pull requests."],
    });
    expect(preset!.skills).toHaveLength(1);
    const skill = preset!.skills[0]!;
    expect(skill.name).toBe("review-checklist");
    expect(skill.description).toBe("Checklist for reviewing a diff: correctness, tests, naming.");
    expect(skill.content).toBe(fixtures["skills/review-checklist/SKILL.md"]!.trim());
    expect(skill.resources).toEqual([
      {
        path: "scripts/count.sh",
        contentBase64: Buffer.from(fixtures["skills/review-checklist/scripts/count.sh"]!).toString(
          "base64",
        ),
        executable: true,
      },
    ]);
  });

  it.each([
    [
      "a folder that disagrees with its id",
      { "presets/reviewer/preset.json": manifest({ id: "other" }) },
      /does not match/,
    ],
    [
      "a missing system prompt",
      { "presets/reviewer/system-prompt.md": undefined },
      /system-prompt\.md/,
    ],
    [
      "a skill missing from the pool",
      { "skills/review-checklist/SKILL.md": undefined },
      /"review-checklist" is not in the skills pool/,
    ],
    ["an unknown icon", { "presets/reviewer/preset.json": manifest({ icon: "rocket" }) }, /icon/],
  ])("names the preset when it has %s", (_label, overrides, message) => {
    const files: Record<string, string> = { ...fixtures };
    for (const [path, value] of Object.entries(overrides)) {
      if (value === undefined) delete files[path];
      else files[path] = value;
    }
    expect(() => decodeAgentPresets(files)).toThrow(/Agent preset "reviewer" is invalid/);
    expect(() => decodeAgentPresets(files)).toThrow(message);
  });

  it("decodes every bundled preset and keeps the pool UTF-8 text", () => {
    const root = import.meta.dirname;
    const bundled = { ...readTree(root, "presets"), ...readTree(root, "skills") };
    const presets = decodeAgentPresets(bundled);
    expect(presets.map((preset) => preset.id)).toEqual(
      Object.keys(bundled)
        .filter((path) => /^presets\/[^/]+\/preset\.json$/.test(path))
        .map((path) => path.split("/")[1])
        .sort(),
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const path of Object.keys(bundled)) {
      expect(
        () => decoder.decode(NodeFS.readFileSync(NodePath.join(root, path))),
        path,
      ).not.toThrow();
    }
  });
});

describe("addPresetSkills", () => {
  const options = { now: "2026-10-29T00:00:00.000Z", makeId: () => "new-skill" };
  const presetSkill = decodeAgentPresets(fixtures)[0]!.skills[0]!;
  const librarySkill = (overrides: Partial<AgentSkill>): AgentSkill => ({
    skillId: "existing",
    name: "My checklist",
    description: "",
    content: presetSkill.content,
    resources: presetSkill.resources,
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("reuses a library skill with identical content and files, whatever its name", () => {
    const library = [librarySkill({})];
    expect(addPresetSkills(library, [presetSkill], options)).toEqual({
      agentSkills: library,
      skillIds: ["existing"],
    });
  });

  it.each([
    ["content", { content: "# Different" }],
    ["files", { resources: [] }],
  ])("adds a new skill when the %s differ", (_label, overrides) => {
    const library = [librarySkill(overrides)];
    const result = addPresetSkills(library, [presetSkill], options);
    expect(result.skillIds).toEqual(["new-skill"]);
    expect(result.agentSkills).toEqual([
      ...library,
      {
        skillId: "new-skill",
        name: "review-checklist",
        description: presetSkill.description,
        content: presetSkill.content,
        resources: presetSkill.resources,
        revision: 1,
        createdAt: options.now,
        updatedAt: options.now,
      },
    ]);
  });

  it("adds one skill when a preset lists the same bundle twice", () => {
    let id = 0;
    const twin: AgentPresetSkill = { ...presetSkill, name: "twin" };
    const result = addPresetSkills([], [presetSkill, twin], {
      ...options,
      makeId: () => `s${++id}`,
    });
    expect(result.skillIds).toEqual(["s1"]);
    expect(result.agentSkills).toHaveLength(1);
  });
});
