import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MAX_SKILL_RESOURCE_BYTES = 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_LIBRARY_BYTES = 8 * 1024 * 1024;

/** Size of a validated base64 resource without allocating a decoded buffer. */
export function skillResourceBytes(contentBase64: string) {
  return (
    (contentBase64.length / 4) * 3 -
    (contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0)
  );
}

/** Portable paths use POSIX separators, including when materialized on Windows. */
export const AgentSkillResourcePath = Schema.String.check(
  Schema.isMaxLength(240),
  Schema.makeFilter(
    (value) => {
      const parts = value.split("/");
      return (
        parts.every(
          (part) =>
            part.length > 0 &&
            part !== "." &&
            part !== ".." &&
            // oxlint-disable-next-line no-control-regex -- Control characters are invalid in portable paths.
            !/[\\\u0000-\u001f\u007f<>:"|?*]/.test(part) &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) &&
            part.toLowerCase() !== ".git",
        ) && parts[0]?.toLowerCase() !== "skill.md"
      );
    },
    { message: "Expected a portable relative file path other than SKILL.md" },
  ),
);

export const AgentSkillResource = Schema.Struct({
  path: AgentSkillResourcePath,
  contentBase64: Schema.String.check(
    Schema.isMaxLength(4 * Math.ceil(MAX_SKILL_RESOURCE_BYTES / 3)),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    Schema.makeFilter(
      (value) => {
        const bytes = skillResourceBytes(value);
        if (bytes > MAX_SKILL_RESOURCE_BYTES) return false;
        if (!value.endsWith("=")) return true;
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        return value.endsWith("==")
          ? (alphabet.indexOf(value.at(-3)!) & 15) === 0
          : (alphabet.indexOf(value.at(-2)!) & 3) === 0;
      },
      { message: "Expected canonical base64" },
    ),
  ),
  executable: Schema.optional(Schema.Boolean),
});
export type AgentSkillResource = typeof AgentSkillResource.Type;

export const AgentSkillResources = Schema.Array(AgentSkillResource).check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (resources) => {
      const paths = new Set(resources.map((file) => file.path.normalize("NFC").toLowerCase()));
      return (
        paths.size === resources.length &&
        resources.every((file) => {
          const parts = file.path.normalize("NFC").toLowerCase().split("/");
          return parts.slice(0, -1).every((_, i) => !paths.has(parts.slice(0, i + 1).join("/")));
        })
      );
    },
    { message: "Resource paths must not collide or overlap" },
  ),
  Schema.makeFilter(
    (resources) =>
      resources.reduce((size, file) => size + skillResourceBytes(file.contentBase64), 0) <=
      MAX_SKILL_BUNDLE_BYTES,
    { message: "Skill resources exceed the 2 MiB bundle limit" },
  ),
);

/** The complete portable bundle is frozen with each thread's profile snapshot. */
export const AgentSkill = Schema.Struct({
  skillId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(1024)),
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  resources: Schema.optional(AgentSkillResources),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type AgentSkill = typeof AgentSkill.Type;
