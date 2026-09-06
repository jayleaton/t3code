import { act, type ReactNode } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { McpGatewaySettings } from "./McpGatewaySettings";
import { MCP_GATEWAY_GRANTS_KEY, MCP_GATEWAY_ENABLED_KEY } from "../../mcpGatewayState";

vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));

vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ children, control }: { children: ReactNode; control: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

it("refreshes visible gateway access when another window changes saved settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  const events = new EventTarget();
  vi.stubGlobal(
    "window",
    Object.assign(events, {
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
      sessionStorage: { getItem: () => "" },
      desktopBridge: { getMcpGatewayLaunchConfig: () => ({ command: "t3", args: [], env: {} }) },
    }),
  );
  const renderer = await act(async () => create(<McpGatewaySettings />));
  try {
    expect(JSON.stringify(renderer.toJSON())).toContain("No registered machines.");
    await act(async () => {
      values.set(MCP_GATEWAY_GRANTS_KEY, JSON.stringify({ remote: ["read"] }));
      values.set(MCP_GATEWAY_ENABLED_KEY, "true");
      events.dispatchEvent(Object.assign(new Event("storage"), { key: MCP_GATEWAY_GRANTS_KEY }));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Unavailable machine");
    expect(JSON.stringify(renderer.toJSON())).toContain("Read only");
    await act(async () => {
      values.clear();
      events.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("No registered machines.");
  } finally {
    await act(async () => renderer.unmount());
  }
});
