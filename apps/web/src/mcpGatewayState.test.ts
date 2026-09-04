import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getMcpGatewayGrants,
  getMcpGatewayProfiles,
  MCP_GATEWAY_GRANTS_KEY,
  MCP_GATEWAY_PROFILES_KEY,
  setMcpGatewayGrants,
  setMcpGatewayProfiles,
} from "./mcpGatewayState";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("MCP gateway grants", () => {
  let localStorage: Storage;

  beforeEach(() => {
    localStorage = storage();
    vi.stubGlobal("window", {
      localStorage,
      dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("persists scopes under exact registry environment ids and defaults to no grants", () => {
    expect(getMcpGatewayGrants()).toEqual({});

    setMcpGatewayGrants({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
    });

    expect(JSON.parse(localStorage.getItem(MCP_GATEWAY_GRANTS_KEY) ?? "null")).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
    });
    expect(getMcpGatewayGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"],
    });
  });

  it("drops malformed persisted grant entries instead of granting access", () => {
    localStorage.setItem(
      MCP_GATEWAY_GRANTS_KEY,
      JSON.stringify({
        primary: ["read", "admin"],
        "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "read", "send"],
        "2549ba75-2a91-4554-8baa-88e6ae0efa48": "read",
      }),
    );

    expect(getMcpGatewayGrants()).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "send"],
    });
  });

  it("persists valid named profiles and drops malformed entries", () => {
    setMcpGatewayProfiles([
      {
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);
    expect(JSON.parse(localStorage.getItem(MCP_GATEWAY_PROFILES_KEY) ?? "null")).toHaveLength(1);
    expect(getMcpGatewayProfiles()).toEqual([
      {
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    ]);

    localStorage.setItem(
      MCP_GATEWAY_PROFILES_KEY,
      JSON.stringify([
        { name: "broken", modelSelection: null, runtimeMode: "admin" },
        {
          name: "Safe",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      ]),
    );
    expect(getMcpGatewayProfiles().map((profile) => profile.name)).toEqual(["Safe"]);
  });
});
