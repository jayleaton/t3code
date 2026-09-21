import { describe, expect, it } from "vite-plus/test";
import { supportsProviderTurnSteering } from "./providerTurnSteering.ts";

describe("provider turn steering", () => {
  it("waits for Command Code headless to exit before sending another prompt", () => {
    expect(supportsProviderTurnSteering("commandcode")).toBe(false);
  });
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"])(
    "preserves %s steering",
    (driver) => expect(supportsProviderTurnSteering(driver)).toBe(true),
  );
});
