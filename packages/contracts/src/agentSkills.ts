import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Portable SKILL.md content, shared independently of an agent's assignments. */
export const AgentSkill = Schema.Struct({
  skillId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  description: Schema.String.check(Schema.isMaxLength(1024)),
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type AgentSkill = typeof AgentSkill.Type;
