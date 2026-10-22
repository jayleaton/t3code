import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render, stubGlobal } from "../../../test/render";
import {
  MCP_GATEWAY_ENABLED_KEY,
  MCP_GATEWAY_GRANTS_KEY,
  MCP_GATEWAY_TOKEN_KEY,
} from "../../mcpGatewayState";

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [], isReady: true })) as never,
}));

import { McpGatewaySettings } from "./McpGatewaySettings";

function gatewayStorage(): Disposable {
  return {
    [Symbol.dispose]() {
      localStorage.removeItem(MCP_GATEWAY_ENABLED_KEY);
      localStorage.removeItem(MCP_GATEWAY_GRANTS_KEY);
      sessionStorage.removeItem(MCP_GATEWAY_TOKEN_KEY);
    },
  };
}

it("keeps the gateway disabled and reports failed storage writes", async () => {
  using _storage = gatewayStorage();
  using _denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage denied");
  });
  await using _screen = await render(<McpGatewaySettings />);
  const toggle = page.getByRole("switch", { name: "Enable MCP Gateway" });
  await userEvent.click(toggle);
  await expect.element(toggle).not.toBeChecked();
  await expect
    .element(page.getByText("Gateway settings could not be saved", { exact: false }))
    .toBeVisible();
});

it("refreshes visible gateway access when another window changes saved settings", async () => {
  using _storage = gatewayStorage();
  using _bridge = stubGlobal("desktopBridge", {
    getMcpGatewayLaunchConfig: () => ({ command: "t3", args: [], env: {} }),
  });
  await using screen = await render(<McpGatewaySettings />);
  const text = () => screen.container.textContent;
  expect(text()).toContain("No registered environments.");
  await act(() => {
    localStorage.setItem(MCP_GATEWAY_GRANTS_KEY, JSON.stringify({ remote: ["read"] }));
    localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: MCP_GATEWAY_GRANTS_KEY }));
  });
  expect(text()).toContain("Unavailable environment");
  expect(text()).toContain("Read environments and threads");
  await act(() => {
    localStorage.removeItem(MCP_GATEWAY_GRANTS_KEY);
    localStorage.removeItem(MCP_GATEWAY_ENABLED_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(text()).toContain("No registered environments.");
});
