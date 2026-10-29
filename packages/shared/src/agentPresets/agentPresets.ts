import {
  AgentSkillResources,
  McpGatewayProfile,
  TrimmedNonEmptyString,
  type AgentSkill,
  type AgentSkillResource,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

const PresetSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/));

/** `presets/<id>/preset.json`. Profile fields reuse the agent schema so a preset always saves. */
export const AgentPresetManifest = Schema.Struct({
  id: PresetSlug,
  name: McpGatewayProfile.fields.name.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(280)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  icon: McpGatewayProfile.fields.icon,
  model: Schema.Struct({
    /** A provider driver such as `codex` or `claudeAgent`, or a provider display name. */
    provider: TrimmedNonEmptyString,
    model: TrimmedNonEmptyString,
    reasoningEffort: Schema.optional(TrimmedNonEmptyString),
  }),
  runtimeMode: McpGatewayProfile.fields.runtimeMode,
  interactionMode: McpGatewayProfile.fields.interactionMode,
  skills: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))),
  setupNotes: Schema.Array(TrimmedNonEmptyString),
});
export type AgentPresetManifest = typeof AgentPresetManifest.Type;

export interface AgentPresetSkill {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly resources: ReadonlyArray<AgentSkillResource>;
}

export interface AgentPreset extends Omit<AgentPresetManifest, "skills"> {
  readonly systemPrompt: string;
  readonly skills: ReadonlyArray<AgentPresetSkill>;
}

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(AgentPresetManifest));
const decodeResources = Schema.decodeUnknownSync(AgentSkillResources);
const decodeSkillText = Schema.decodeUnknownSync(
  Schema.Struct({
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    description: Schema.String.check(Schema.isMaxLength(1024)),
    content: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  }),
);

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return {};
  const value: unknown = parseYaml(match[1] ?? "");
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function utf8Base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeSkill(name: string, files: Readonly<Record<string, string>>): AgentPresetSkill {
  const root = `skills/${name}/`;
  const content = files[`${root}SKILL.md`];
  if (content === undefined) throw new Error(`skill "${name}" is not in the skills pool`);
  try {
    const meta = frontmatter(content);
    const text = decodeSkillText({
      name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : name,
      description: typeof meta.description === "string" ? meta.description.trim() : "",
      content,
    });
    const resources = decodeResources(
      Object.keys(files)
        .filter((path) => path.startsWith(root) && path !== `${root}SKILL.md`)
        .sort()
        .map((path) => ({
          path: path.slice(root.length),
          contentBase64: utf8Base64(files[path]!),
          ...(files[path]!.startsWith("#!") ? { executable: true } : {}),
        })),
    );
    return { ...text, resources };
  } catch (cause) {
    throw new Error(`skill "${name}": ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/**
 * Decodes file text keyed by path under agentPresets/: `presets/<id>/…` and the
 * shared `skills/<name>/…` pool. Bundles carry UTF-8 text, so a script's
 * executable bit comes from its shebang, the only way it can run directly.
 */
export function decodeAgentPresets(files: Readonly<Record<string, string>>) {
  const skills = new Map<string, AgentPresetSkill>();
  const ids = Object.keys(files)
    .filter((path) => /^presets\/[^/]+\/preset\.json$/.test(path))
    .map((path) => path.split("/")[1]!)
    .sort();
  return ids.map((id): AgentPreset => {
    try {
      const { skills: names, ...manifest } = decodeManifest(files[`presets/${id}/preset.json`]);
      if (manifest.id !== id) throw new Error(`id "${manifest.id}" does not match its folder`);
      const systemPrompt = files[`presets/${id}/system-prompt.md`]?.trim();
      if (systemPrompt === undefined) throw new Error("missing system-prompt.md");
      if (systemPrompt.length > 32_000) throw new Error("system-prompt.md is too long");
      return {
        ...manifest,
        systemPrompt,
        skills: names.map((name) => {
          const skill = skills.get(name) ?? decodeSkill(name, files);
          skills.set(name, skill);
          return skill;
        }),
      };
    } catch (cause) {
      throw new Error(
        `Agent preset "${id}" is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  });
}

function bundleKey(skill: Pick<AgentSkill, "content" | "resources">) {
  return JSON.stringify([
    skill.content.trim(),
    (skill.resources ?? [])
      .map((file) => [file.path, file.contentBase64, file.executable === true] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

/** A library skill whose SKILL.md and files match exactly, whatever its name. */
export function findIdenticalSkill(
  library: ReadonlyArray<AgentSkill>,
  skill: Pick<AgentSkill, "content" | "resources">,
) {
  const key = bundleKey(skill);
  return library.find((candidate) => bundleKey(candidate) === key);
}

/** Adds preset skills to the library, reusing identical skills instead of duplicating them. */
export function addPresetSkills(
  library: ReadonlyArray<AgentSkill>,
  skills: ReadonlyArray<AgentPresetSkill>,
  options: { readonly now: string; readonly makeId: () => string },
) {
  const agentSkills = [...library];
  const skillIds = skills.map((skill) => {
    const existing = findIdenticalSkill(agentSkills, skill);
    if (existing) return existing.skillId;
    const created: AgentSkill = {
      skillId: options.makeId(),
      name: skill.name,
      description: skill.description,
      content: skill.content,
      ...(skill.resources.length ? { resources: skill.resources } : {}),
      revision: 1,
      createdAt: options.now,
      updatedAt: options.now,
    };
    agentSkills.push(created);
    return created.skillId;
  });
  return { agentSkills, skillIds: [...new Set(skillIds)] };
}
