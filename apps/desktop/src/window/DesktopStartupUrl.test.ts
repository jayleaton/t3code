import { describe, expect, it } from "vite-plus/test";
import { getDesktopStartupUrl } from "./DesktopStartupUrl.ts";

describe("desktop startup route", () => {
  it("opens the Agents board in the production fork", () => {
    expect(getDesktopStartupUrl(false, "agents")).toBe("t3code://app/#/agents");
  });

  it("keeps the development protocol when testing the fork", () => {
    expect(getDesktopStartupUrl(true, "agents")).toBe("t3code-dev://app/#/agents");
  });

  it("retains the standard startup route for upstream builds", () => {
    expect(getDesktopStartupUrl(false, "t3")).toBe("t3code://app/");
    expect(getDesktopStartupUrl(true)).toBe("t3code-dev://app/");
  });
});
