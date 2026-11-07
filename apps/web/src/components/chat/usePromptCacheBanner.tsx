import { SnowflakeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import {
  COLD_CACHE_WARNING_MIN_TOKENS,
  coldSendCostMultiplier,
  promptCacheExpiresAt,
} from "../../lib/promptCache";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Warns once a large thread's prompt cache has lapsed, so the user can compact before the next
 * send re-reads everything at full price. Sending is never blocked.
 */
export function usePromptCacheBanner(input: {
  readonly threadKey: string;
  readonly ttlMs: number | null;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly isWorking: boolean;
  readonly compactDisabled: boolean;
  readonly onCompact: () => void;
}): ComposerBannerStackItem | null {
  const { threadKey, ttlMs, contextWindow, isWorking, compactDisabled, onCompact } = input;
  const usedTokens = contextWindow?.usedTokens ?? 0;
  const watch =
    ttlMs !== null &&
    contextWindow !== null &&
    !isWorking &&
    usedTokens >= COLD_CACHE_WARNING_MIN_TOKENS;
  const expiresAt = watch ? promptCacheExpiresAt(contextWindow.updatedAt, ttlMs) : null;
  const bannerKey = expiresAt === null ? null : `prompt-cache-cold:${threadKey}:${expiresAt}`;
  const [coldKey, setColdKey] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer for the wall-clock moment the provider's cache lapses
  useEffect(() => {
    if (bannerKey === null || expiresAt === null) return;
    const timer = setTimeout(() => setColdKey(bannerKey), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [bannerKey, expiresAt]);

  if (bannerKey === null || ttlMs === null || coldKey !== bannerKey || dismissedKey === bannerKey) {
    return null;
  }
  const multiplier = Math.round(coldSendCostMultiplier(ttlMs));
  return {
    id: bannerKey,
    variant: "warning",
    icon: <SnowflakeIcon />,
    title: "Prompt cache went cold",
    description: `Your next message re-sends ${formatContextWindowTokens(usedTokens)} tokens of context at about ${multiplier}× the cached price. Compacting first shrinks that.`,
    actions: (
      <Button size="xs" variant="ghost" disabled={compactDisabled} onClick={onCompact}>
        Compact first
      </Button>
    ),
    dismissLabel: "Dismiss cold cache notice",
    onDismiss: () => setDismissedKey(bannerKey),
  };
}
