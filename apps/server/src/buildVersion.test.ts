import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import packageJson from "../package.json" with { type: "json" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("server build version", () => {
  it("uses the source manifest for unbundled development", async () => {
    const { serverBuildVersion } = await import("./buildVersion.ts");
    expect(serverBuildVersion).toBe(packageJson.version);
  });

  it("reports the release version supplied when bundling, without a manifest bump", async () => {
    vi.stubGlobal("__T3CODE_BUILD_VERSION__", "0.0.41-nightly.20260915.9002");
    const { serverBuildVersion } = await import("./buildVersion.ts");
    expect(serverBuildVersion).toBe("0.0.41-nightly.20260915.9002");
  });
});
