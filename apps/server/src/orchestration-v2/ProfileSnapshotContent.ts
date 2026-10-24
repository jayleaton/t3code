// @effect-diagnostics nodeBuiltinImport:off - stored events are hashed synchronously while they decode
import * as NodeCrypto from "node:crypto";

import { AgentSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An agent's instructions and skills as frozen onto a thread. Skills carry whole SKILL.md
 * bodies and resources, so threads and their events reference this by hash instead of
 * repeating it.
 */
export const ProfileSnapshotContent = Schema.Struct({
  systemPrompt: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  skills: Schema.Array(AgentSkill),
});
export type ProfileSnapshotContent = typeof ProfileSnapshotContent.Type;

const LegacyProfileSnapshotContent = Schema.Struct({
  systemPrompt: ProfileSnapshotContent.fields.systemPrompt,
  skills: Schema.optional(ProfileSnapshotContent.fields.skills),
});
const decodeLegacyContent = Schema.decodeUnknownOption(LegacyProfileSnapshotContent);
const encodeContentJson = Schema.encodeEffect(Schema.fromJsonString(ProfileSnapshotContent));

// Key order differs between content built from settings and content parsed from a stored
// payload, so the hash covers a key-sorted serialization.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function profileSnapshotContentHash(content: ProfileSnapshotContent): string {
  const digest = NodeCrypto.createHash("sha256").update(canonicalJson(content)).digest("hex");
  return `sha256:${digest}`;
}

/**
 * Threads created before instructions and skills moved to `profile_snapshots` stored them
 * inline, and their events still do. Moves them out and references them by hash; the fork
 * migration that created the table stored every such content, so the hash resolves.
 */
export function splitLegacyProfileSnapshot(snapshot: unknown): {
  readonly snapshot: unknown;
  readonly content: ProfileSnapshotContent | undefined;
} {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !("skills" in snapshot || "systemPrompt" in snapshot)
  ) {
    return { snapshot, content: undefined };
  }
  const { skills, systemPrompt, ...reference } = snapshot as Record<string, unknown>;
  const legacy = decodeLegacyContent({ skills, systemPrompt });
  if (Option.isNone(legacy)) return { snapshot: reference, content: undefined };
  const content: ProfileSnapshotContent = {
    ...(legacy.value.systemPrompt === undefined ? {} : { systemPrompt: legacy.value.systemPrompt }),
    skills: legacy.value.skills ?? [],
  };
  return {
    snapshot: { ...reference, contentHash: profileSnapshotContentHash(content) },
    content,
  };
}

/** A stored thread payload with any inline profile content replaced by its hash. */
export function withoutLegacyProfileContent(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("profileSnapshot" in payload)) {
    return payload;
  }
  const split = splitLegacyProfileSnapshot(payload.profileSnapshot);
  return split.snapshot === payload.profileSnapshot
    ? payload
    : { ...payload, profileSnapshot: split.snapshot };
}

/** Rows are immutable and content-addressed, so a repeated write is a no-op. */
export const storeProfileSnapshotContent = Effect.fn("ProfileSnapshotContent.store")(function* (
  content: ProfileSnapshotContent,
) {
  const sql = yield* SqlClient.SqlClient;
  const contentHash = profileSnapshotContentHash(content);
  const contentJson = yield* encodeContentJson(content);
  yield* sql`
    INSERT INTO profile_snapshots (content_hash, content_json)
    VALUES (${contentHash}, ${contentJson})
    ON CONFLICT(content_hash) DO NOTHING
  `;
  return contentHash;
});
