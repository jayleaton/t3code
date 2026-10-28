import { McpSchema } from "effect/ai";

/** Verified Claude/Codex harnesses read structuredContent without enforcing outputSchema;
 * their text copy wastes context. Other clients, including older t3 thread schema decoders,
 * retain the full result shape. */
const LEAN_CLIENTS: ReadonlySet<string> = new Set(["claude-code", "codex-mcp-client"]);

export const wantsLeanResults = (client: McpSchema.Implementation | undefined): boolean =>
  client !== undefined && LEAN_CLIENTS.has(client.name);

/**
 * The single copy a lean client's model reads: `structuredContent` without
 * empty or redundant fields, and no text block. Failures keep their full shape.
 */
export const leanToolResult = (
  result: McpSchema.CallToolResult,
  callerThreadId: string | undefined,
): McpSchema.CallToolResult =>
  result.isError === true || result.structuredContent === undefined
    ? result
    : new McpSchema.CallToolResult({
        ...result,
        structuredContent: leanJson(result.structuredContent, callerThreadId) as Record<
          string,
          unknown
        >,
        content: result.content.filter((block) => block.type !== "text"),
      });

/**
 * Drops `null`, `undefined`, and empty-array properties at any depth, plus
 * values the reader already has: a `childNodeId` equal to its `taskId`, an
 * `ownerThreadId` that is the calling chat, and `environmentIds` that repeat
 * `availableEnvironmentIds`. `false`, `0`, `""`, `{}` and array positions stay.
 */
export function leanJson(value: unknown, callerThreadId: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((element) => leanJson(element, callerThreadId));
  if (!isPlainObject(value)) return value;
  const lean: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === null || field === undefined) continue;
    if (Array.isArray(field) && field.length === 0) continue;
    if (key === "childNodeId" && field === value.taskId) continue;
    if (key === "ownerThreadId" && callerThreadId !== undefined && field === callerThreadId) {
      continue;
    }
    if (key === "environmentIds" && sameMembers(field, value.availableEnvironmentIds)) continue;
    lean[key] = leanJson(field, callerThreadId);
  }
  return lean;
}

function sameMembers(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

// Class instances (dates, buffers, schema classes) serialize through their own toJSON.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
