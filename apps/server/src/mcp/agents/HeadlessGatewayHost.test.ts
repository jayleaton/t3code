import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  parseGatewayEnvFile,
  resolveHeadlessGatewaySettings,
  takeLauncherEnvironment,
} from "./HeadlessGatewayHost.ts";

const TOKEN = "headless-token-0123456789";
const base = {
  homeDirectory: "/home/jj",
  baseDir: "/home/jj/.t3",
  mode: "web" as const,
};

describe("parseGatewayEnvFile", () => {
  it("reads systemd-style assignments, quotes, and comments", () => {
    expect(
      parseGatewayEnvFile(
        `# gateway\nT3_MCP_BRIDGE_TOKEN="${TOKEN}"\nexport T3_MCP_HEADLESS_GATEWAY=1\n\nnot a line\nT3_MCP_BRIDGE_PORT='47700'\n`,
      ),
    ).toEqual({
      T3_MCP_BRIDGE_TOKEN: TOKEN,
      T3_MCP_HEADLESS_GATEWAY: "1",
      T3_MCP_BRIDGE_PORT: "47700",
    });
  });
});

describe("takeLauncherEnvironment", () => {
  it.effect("keeps the gateway variables from children and hands them to the host", () =>
    Effect.gen(function* () {
      const launcher = {
        T3_MCP_HEADLESS_GATEWAY: "1",
        T3_MCP_HEADLESS_SCOPES: "read,delivery",
        T3_MCP_BRIDGE_PORT: "47700",
        T3_MCP_BRIDGE_TOKEN: TOKEN,
        T3_MCP_REPOSITORY_ALLOWLIST: "jayleaton/t3code",
        T3_MCP_EVENT_RETENTION: "5000",
        T3_MCP_STATE_FILE: "/home/jj/.t3/mcp-gateway-v3.sqlite",
        T3_MCP_GRANTS: "{}",
      };
      const ordinary = { PATH: "/usr/bin", HOME: "/home/jj", TMPDIR: "/home/jj/.t3/tmp" };
      const env: NodeJS.ProcessEnv = { ...ordinary, ...launcher };

      const taken = yield* takeLauncherEnvironment().pipe(
        Effect.provideService(HostProcess.Environment, env),
      );

      expect(env).toEqual(ordinary);
      expect(taken).toEqual(launcher);
      expect(
        resolveHeadlessGatewaySettings({ ...base, env: { ...env, ...taken }, file: {} }),
      ).toMatchObject({ enabled: true, config: { port: 47700, token: TOKEN } });
    }),
  );
});

describe("resolveHeadlessGatewaySettings", () => {
  it("stays off unless opted in", () => {
    expect(
      resolveHeadlessGatewaySettings({ ...base, env: {}, file: { T3_MCP_BRIDGE_TOKEN: TOKEN } }),
    ).toMatchObject({ enabled: false });
  });

  it("leaves the runtime to the desktop app's renderer", () => {
    expect(
      resolveHeadlessGatewaySettings({
        ...base,
        mode: "desktop",
        env: { T3_MCP_HEADLESS_GATEWAY: "1", T3_MCP_BRIDGE_TOKEN: TOKEN },
        file: {},
      }),
    ).toMatchObject({ enabled: false, reason: "The desktop app hosts the gateway runtime." });
  });

  it("uses the desktop's store and default read and delivery scopes", () => {
    expect(
      resolveHeadlessGatewaySettings({
        ...base,
        env: {},
        file: { T3_MCP_HEADLESS_GATEWAY: "1", T3_MCP_BRIDGE_TOKEN: TOKEN },
      }),
    ).toEqual({
      enabled: true,
      scopes: ["read", "delivery"],
      config: {
        port: 47631,
        token: TOKEN,
        stateFile: "/home/jj/.t3/mcp-gateway-v3.sqlite",
        retentionEvents: 100_000,
        repositoryAllowlist: ["jayleaton/t3code"],
        initialGrants: {},
      },
    });
  });

  it("lets the process environment override the file", () => {
    const settings = resolveHeadlessGatewaySettings({
      ...base,
      env: { T3_MCP_BRIDGE_PORT: "47700", T3_MCP_HEADLESS_SCOPES: "read,delivery,send" },
      file: {
        T3_MCP_HEADLESS_GATEWAY: "true",
        T3_MCP_BRIDGE_TOKEN: TOKEN,
        T3_MCP_BRIDGE_PORT: "1",
      },
    });
    expect(settings).toMatchObject({
      enabled: true,
      scopes: ["read", "delivery", "send"],
      config: { port: 47700 },
    });
  });

  it("reports why it cannot start", () => {
    const on = { T3_MCP_HEADLESS_GATEWAY: "1" };
    expect(resolveHeadlessGatewaySettings({ ...base, env: on, file: {} })).toMatchObject({
      enabled: false,
      reason: "T3_MCP_BRIDGE_TOKEN must contain at least 16 characters.",
    });
    expect(
      resolveHeadlessGatewaySettings({
        ...base,
        env: { ...on, T3_MCP_BRIDGE_TOKEN: TOKEN, T3_MCP_HEADLESS_SCOPES: "read,everything" },
        file: {},
      }),
    ).toMatchObject({ enabled: false, reason: expect.stringContaining("everything") });
    expect(
      resolveHeadlessGatewaySettings({
        ...base,
        env: { ...on, T3_MCP_BRIDGE_TOKEN: TOKEN, T3_MCP_HEADLESS_SCOPES: "delivery" },
        file: {},
      }),
    ).toMatchObject({ enabled: false, reason: "T3_MCP_HEADLESS_SCOPES must include read." });
  });
});
