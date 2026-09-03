import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getMcpGatewayStatus,
  getMcpGatewayToken,
  getMcpGatewayGrants,
  MCP_GATEWAY_ENABLED_KEY,
  MCP_GATEWAY_GRANTS_KEY,
  publishMcpGatewayStatus,
  setMcpGatewayGrants,
  subscribeMcpGatewayConfiguration,
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
  let listeners: Map<string, EventListener>;

  beforeEach(() => {
    localStorage = storage();
    listeners = new Map();
    vi.stubGlobal("window", {
      localStorage,
      dispatchEvent: vi.fn(),
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
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

  it("returns an empty token when session storage is unavailable", () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    });

    expect(getMcpGatewayToken()).toBe("");
  });

  it("replays the latest gateway status to settings mounted after startup", () => {
    publishMcpGatewayStatus("running");

    expect(getMcpGatewayStatus()).toBe("running");
  });

  it("observes gateway configuration changes from other tabs", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeMcpGatewayConfiguration(onChange);

    listeners.get("storage")?.({ key: MCP_GATEWAY_ENABLED_KEY } as StorageEvent);
    expect(onChange).toHaveBeenCalledOnce();

    listeners.get("storage")?.({ key: "unrelated" } as StorageEvent);
    expect(onChange).toHaveBeenCalledOnce();

    unsubscribe();
    expect(listeners.has("storage")).toBe(false);
  });
});
