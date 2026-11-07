// When the provider's prompt cache lapses, the next message re-sends the whole context at full
// price. After Cache Keeper by Nate Herk (MIT): https://github.com/nateherkai/claude-code-mods
import type { ProviderDriverKind } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
/** Below this, a cold cache costs too little to interrupt anyone about. */
export const COLD_CACHE_WARNING_MIN_TOKENS = 100_000;

const CLAUDE_KEY_AUTH_TYPES = new Set(["apiKey", "bedrock", "customEndpoint"]);

/**
 * Claude Code writes 1-hour cache entries on a subscription and 5-minute ones on an API key.
 * Other providers do not report enough to say, so they get null and no cache UI.
 */
export function promptCacheTtlMs(
  driverKind: ProviderDriverKind | null | undefined,
  authType: string | null | undefined,
): number | null {
  if (driverKind !== "claudeAgent" || !authType) return null;
  return (CLAUDE_KEY_AUTH_TYPES.has(authType) ? 5 : 60) * MINUTE_MS;
}

/**
 * How many times a warm send's context cost a cold send pays: a cache read is 0.1x the input
 * price, a fresh write 1.25x (5-minute entries) or 2x (1-hour entries).
 */
export function coldSendCostMultiplier(ttlMs: number): number {
  return (ttlMs >= 60 * MINUTE_MS ? 2 : 1.25) / 0.1;
}

export function promptCacheExpiresAt(lastActivityAt: string, ttlMs: number): number | null {
  const at = Date.parse(lastActivityAt);
  return Number.isFinite(at) ? at + ttlMs : null;
}

export function formatCacheTimeLeft(ms: number): string {
  if (ms < MINUTE_MS) return "under a minute";
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
