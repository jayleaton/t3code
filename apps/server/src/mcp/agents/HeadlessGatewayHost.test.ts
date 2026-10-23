import { describe, expect, it } from "@effect/vitest";

import { parseGatewayEnvFile, resolveHeadlessGatewaySettings } from "./HeadlessGatewayHost.ts";

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
