import {
  type ModelCapabilities,
  type RuntimeMode,
  type TurnTokenUsage,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CommandCodeFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("event"),
    event: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.Literals(["success", "error", "max_turns"]),
    sessionId: Schema.optional(Schema.String),
    stopReason: Schema.optional(Schema.String),
    finalText: Schema.String,
    usage: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.String),
  }),
]);
export type CommandCodeFrame = typeof CommandCodeFrame.Type;
export const decodeCommandCodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(CommandCodeFrame),
);

// Headless mode cannot deliver approval responses over stdin. Never elevate a
// normal T3 session to bypass mode just to make a denied tool work.
export function commandCodePermissionArgs(mode: RuntimeMode, plan: boolean): string[] {
  if (plan) return ["--plan"];
  if (mode === "full-access") return ["--yolo"];
  return ["--permission-mode", mode === "auto-accept-edits" ? "auto-accept" : "dont-ask"];
}

export const COMMAND_CODE_MODEL_CAPABILITIES = {
  optionDescriptors: [],
} satisfies ModelCapabilities;

export function parseCommandCodeModels(output: string): ServerProviderModel[] {
  const models: ServerProviderModel[] = [
    {
      slug: "default",
      name: "Command Code default",
      isCustom: false,
      isDefault: true,
      capabilities: COMMAND_CODE_MODEL_CAPABILITIES,
    },
  ];
  const seen = new Set(["default"]);
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9._:/-]*)\s{2,}\S/i.exec(line);
    const slug = match?.[1];
    if (!slug || seen.has(slug) || slug === "Docs:") continue;
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: false,
      capabilities: COMMAND_CODE_MODEL_CAPABILITIES,
    });
  }
  return models;
}

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    inputTokens: TokenCount,
    outputTokens: TokenCount,
    cacheReadTokens: Schema.optional(TokenCount),
    cacheWriteTokens: Schema.optional(TokenCount),
  }),
);

export function commandCodeTokenUsage(value: unknown, hasSubagents: boolean): TurnTokenUsage {
  const parsed = decodeUsage(value);
  if (parsed._tag === "None")
    return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
  const usage = parsed.value;
  // Command Code's inputTokens includes cached tokens (its billing calculation
  // subtracts cache reads/writes before charging uncached input).
  return {
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteTokens }
      : {}),
  };
}

const encodeData = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export function commandCodeToolData(value: unknown): unknown {
  if (value === undefined) return undefined;
  const encoded = encodeData(value);
  return encoded.length <= 16_384 ? value : `${encoded.slice(0, 16_384)}… (truncated)`;
}
