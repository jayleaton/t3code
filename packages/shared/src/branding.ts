/**
 * The fork's user-visible identity. Every surface reads the name from here so a rename is one
 * edit and an upstream sync cannot quietly bring the old name back (scripts/upstream-install-commands.test.ts).
 * Internal identifiers (package names, T3CODE_* env vars, ~/.t3, deep-link schemes, app IDs)
 * deliberately keep their upstream names so existing installs update in place.
 */
export const APP_NAME = "Ada";
export const APP_FULL_NAME = "Agentic Desktop Application";
export const APP_SLOGAN = "Engineering is better with Agents.";

// null hides the store buttons and QR codes until Ada has its own listing.
export const MOBILE_APP_STORE_LINKS: {
  readonly ios: string | null;
  readonly android: string | null;
} = { ios: null, android: null };

/** The CLI's primary name. `t3` stays installed beside it so existing scripts and service units keep working. */
export const CLI_COMMAND = "ada";
export const LEGACY_CLI_COMMAND = "t3";

/**
 * The upstream app this fork installs beside and protects (shared profile, installer guards).
 * Use it only where the copy names that other product, never for this app.
 */
export const UPSTREAM_APP_NAME = "T3 Code";
