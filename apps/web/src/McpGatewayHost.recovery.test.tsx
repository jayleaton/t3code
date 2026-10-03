import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import { McpGatewayHost } from "./McpGatewayHost";
import { restartMcpGateway, getMcpGatewayStatus } from "./mcpGatewayState";
import type { AppRouter } from "./router";

const { connect, stop } = vi.hoisted(() => ({ connect: vi.fn(), stop: vi.fn() }));
vi.mock("@t3tools/client-runtime/gateway", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/gateway")>()),
  connectGatewayBridge: connect,
  createGatewayRuntimePortFromContext: vi.fn(),
  createGatewayRuntimeEventSourceFromContext: vi.fn(),
}));
vi.mock("./connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./rpc/atomRegistry", () => ({
  appAtomRegistry: {
    mount: () => () => {},
    get: () => AsyncResult.success({}),
  },
}));
afterEach(() => vi.unstubAllGlobals());

it("restarts the configured profile gateway through desktop IPC and replaces its bridge", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const configure = vi.fn().mockResolvedValue(undefined);
  connect.mockReturnValue({ stop, requestStatus: () => true });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {
        getMcpGatewayLaunchConfig: () => ({}),
        configureManagedMcpGateway: configure,
      },
      localStorage: { getItem: (key: string) => (key.endsWith("enabled") ? "true" : null) },
      sessionStorage: { getItem: () => "test-token-with-enough-characters" },
    }),
  );
  const renderer = await act(async () => create(<McpGatewayHost router={{} as AppRouter} />));
  try {
    expect(connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(restartMcpGateway()).toBe(true);
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(configure.mock.calls.map(([input]) => (input === null ? "stop" : "start"))).toEqual([
      "start",
      "stop",
      "start",
    ]);
    expect(configure.mock.calls[2]?.[0]).toEqual(configure.mock.calls[0]?.[0]);
    configure.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("startup failed"));
    await act(async () => {
      restartMcpGateway();
    });
    expect(getMcpGatewayStatus()).toBe("degraded");
  } finally {
    await act(async () => renderer.unmount());
  }
  expect(restartMcpGateway()).toBe(false);
});
