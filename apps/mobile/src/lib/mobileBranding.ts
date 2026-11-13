import { APP_NAME } from "@t3tools/shared/branding";

/**
 * Every header and label reads the name from here, so an upstream sync that edits a header cannot
 * quietly bring back the upstream name: it has to change this file, which mobileBranding.test.ts pins.
 */
export const MOBILE_APP_NAME = APP_NAME;

export type MobileStageLabel = "Dev" | "Nightly";

/** Release builds carry no stage badge; dev and preview builds keep one to tell them apart. */
export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel | null {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return null;
}
