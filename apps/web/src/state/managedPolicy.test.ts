import { ProviderDriverKind, type ManagedPolicySummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { managedInstanceLocks, usageDataNotice } from "./managedPolicy";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

const policy: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: {
    providers: {
      lockedInstanceFields: {
        [codex]: ["config.binaryPath", "environment.OPENAI_BASE_URL", "environment.HTTPS_PROXY"],
      },
    },
  },
};

describe("managedInstanceLocks", () => {
  it("splits locked instance paths into config keys and environment names", () => {
    const locks = managedInstanceLocks(policy, codex);
    expect(locks && [...locks.configKeys]).toEqual(["binaryPath"]);
    expect(locks && [...locks.environmentNames]).toEqual(["OPENAI_BASE_URL", "HTTPS_PROXY"]);
    expect(locks?.reason).toBe("Managed by Example Corp.");
  });

  it("treats a bare environment path as every variable", () => {
    const ceilingPolicy = {
      ...policy,
      limits: {
        providers: { lockedInstanceFields: { [codex]: ["config.binaryPath", "environment"] } },
      },
    };
    const locks = managedInstanceLocks(ceilingPolicy, codex);
    expect(locks?.wholeEnvironment).toBe(true);
    expect(managedInstanceLocks(policy, codex)?.wholeEnvironment).toBe(false);
  });

  it("locks nothing for drivers the policy does not pin, or without a policy", () => {
    expect(managedInstanceLocks(policy, claude)).toBeUndefined();
    expect(managedInstanceLocks(undefined, codex)).toBeUndefined();
  });
});

describe("usageDataNotice", () => {
  it.each([
    {
      name: "a server that reports usage data off",
      config: { telemetryEnabled: false },
      notice: "Ada doesn't collect usage data.",
    },
    {
      name: "a server that opted in",
      config: { telemetryEnabled: true },
      notice:
        "This server sends anonymous usage data because T3CODE_TELEMETRY_ENABLED is on. Update it to stop.",
    },
    // Older servers do not report it and send by default, so opt-in is not promised for them.
    {
      name: "an older server",
      config: {},
      notice:
        "This server may send anonymous usage data. Update it, or set T3CODE_TELEMETRY_ENABLED=false on it.",
    },
  ])("describes $name", ({ config, notice }) => {
    expect(usageDataNotice(config)).toBe(notice);
  });
});
