import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coldSendCostMultiplier,
  formatCacheTimeLeft,
  promptCacheExpiresAt,
  promptCacheTtlMs,
} from "./promptCache";

const claude = ProviderDriverKind.make("claudeAgent");

describe("promptCacheTtlMs", () => {
  it.each([
    [claude, "max", 60 * 60_000],
    [claude, "pro", 60 * 60_000],
    [claude, "apiKey", 5 * 60_000],
    [claude, "bedrock", 5 * 60_000],
    [claude, undefined, null],
    [ProviderDriverKind.make("codex"), "pro", null],
  ])("%s with %s auth → %s", (driverKind, authType, expected) => {
    expect(promptCacheTtlMs(driverKind, authType)).toBe(expected);
  });
});

describe("coldSendCostMultiplier", () => {
  it("prices a cold send against a cache read", () => {
    expect(coldSendCostMultiplier(60 * 60_000)).toBe(20);
    expect(coldSendCostMultiplier(5 * 60_000)).toBe(12.5);
  });
});

describe("promptCacheExpiresAt", () => {
  it("adds the TTL to the last activity, and ignores bad timestamps", () => {
    expect(promptCacheExpiresAt("2026-01-01T00:00:00.000Z", 5 * 60_000)).toBe(
      Date.parse("2026-01-01T00:05:00.000Z"),
    );
    expect(promptCacheExpiresAt("not a date", 5 * 60_000)).toBeNull();
  });
});

describe("formatCacheTimeLeft", () => {
  it.each([
    [30_000, "under a minute"],
    [42 * 60_000, "42 min"],
    [60 * 60_000, "1 h"],
    [65 * 60_000, "1 h 5 min"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatCacheTimeLeft(ms)).toBe(expected);
  });
});
