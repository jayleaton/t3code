import { afterEach, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { create } from "react-test-renderer";

import { McpGatewayHost } from "./McpGatewayHost";
import type { AppRouter } from "./router";

const { mount } = vi.hoisted(() => ({ mount: vi.fn() }));
vi.mock("./rpc/atomRegistry", () => ({ appAtomRegistry: { mount } }));
vi.mock("./connection/runtime", () => ({ connectionAtomRuntime: {} }));

afterEach(() => vi.unstubAllGlobals());

it("keeps older desktop shells usable without mounting an unsupported gateway", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {},
      localStorage: { getItem: () => "true" },
      sessionStorage: { getItem: () => "test-token-with-enough-characters" },
    }),
  );
  const renderer = await act(async () => create(<McpGatewayHost router={{} as AppRouter} />));
  try {
    expect(mount).not.toHaveBeenCalled();
  } finally {
    await act(async () => renderer.unmount());
  }
});
