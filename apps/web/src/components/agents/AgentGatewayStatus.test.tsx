import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AgentGatewayStatus } from "./AgentGatewayStatus";
import {
  MCP_GATEWAY_STATE_EVENT,
  publishMcpGatewayStatus,
  publishMcpGatewayStatusSnapshot,
  setMcpGatewayRestarter,
  setMcpGatewayStatusRequester,
} from "../../mcpGatewayState";

let renderer: ReactTestRenderer;
const restart = vi.fn();
const requestStatus = vi.fn(() => true);
const snapshot = {
  schemaVersion: "3" as const,
  capturedAt: new Date().toISOString(),
  live: true,
  stale: false,
  retention: { maxEventsPerEnvironment: 100, maxAgeDays: 7 },
  environments: [],
};
const text = () => JSON.stringify(renderer.toJSON());
const restartButton = () => renderer.root.findByProps({ "aria-label": "Restart agent gateway" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      localStorage: { getItem: () => "true" },
      desktopBridge: { getMcpGatewayLaunchConfig: () => ({}) },
    }),
  );
  publishMcpGatewayStatus("running");
  publishMcpGatewayStatusSnapshot(null);
  setMcpGatewayRestarter(restart);
  setMcpGatewayStatusRequester(requestStatus);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  setMcpGatewayRestarter(null);
  setMcpGatewayStatusRequester(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("requires a live bridge snapshot and invalidates health on disconnect", async () => {
  renderer = await act(async () => create(<AgentGatewayStatus />));
  expect(text()).toContain("Disconnected");
  await act(async () => publishMcpGatewayStatusSnapshot(snapshot));
  expect(text()).toContain("Connected");
  await act(async () => publishMcpGatewayStatus("degraded"));
  expect(text()).toContain("Disconnected");
  expect(restartButton()).toBeDefined();
});

it("does not treat stale sidecar data as healthy", async () => {
  renderer = await act(async () => create(<AgentGatewayStatus />));
  await act(async () => publishMcpGatewayStatusSnapshot({ ...snapshot, stale: true }));
  expect(text()).toContain("Disconnected");
});

it("waits for live health after restart and prevents duplicate recovery", async () => {
  renderer = await act(async () => create(<AgentGatewayStatus />));
  await act(async () => restartButton().props.onClick());
  expect(restart).toHaveBeenCalledOnce();
  expect(text()).toContain("Recovering");
  expect(restartButton().props.disabled).toBe(true);
  await act(async () => restartButton().props.onClick());
  expect(restart).toHaveBeenCalledOnce();
  await act(async () => publishMcpGatewayStatus("running"));
  expect(text()).toContain("Recovering");
  await act(async () => publishMcpGatewayStatusSnapshot(snapshot));
  expect(text()).toContain("Connected");
  expect(text()).not.toContain("Restarting");
});

it("shows recovery timeout and permits retry without exposing raw errors", async () => {
  renderer = await act(async () => create(<AgentGatewayStatus />));
  await act(async () => restartButton().props.onClick());
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(text()).toContain("Gateway recovery failed");
  expect(restartButton().props.disabled).toBe(false);
  restart.mockImplementationOnce(() => {
    throw new Error("secret-bridge-token");
  });
  await act(async () => restartButton().props.onClick());
  expect(text()).toContain("Gateway restart is unavailable");
  expect(text()).not.toContain("secret-bridge-token");
});

it("detects an unresponsive bridge and restores health when replies resume", async () => {
  renderer = await act(async () => create(<AgentGatewayStatus />));
  await act(async () => publishMcpGatewayStatusSnapshot(snapshot));
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(text()).toContain("Gateway did not respond");
  await act(async () => publishMcpGatewayStatusSnapshot(snapshot));
  expect(text()).toContain("Connected");
  expect(text()).not.toContain("Gateway did not respond");
});

it("does not offer local desktop recovery in a remote web browser", async () => {
  Object.assign(window, { desktopBridge: undefined });
  renderer = await act(async () => create(<AgentGatewayStatus />));
  expect(text()).toContain("Desktop only");
  expect(requestStatus).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
});

it("reflects gateway disablement during recovery and cancels health timers on unmount", async () => {
  renderer = await act(async () => create(<AgentGatewayStatus />));
  await act(async () => restartButton().props.onClick());
  await act(async () => {
    Object.assign(window, { localStorage: { getItem: () => "false" } });
    window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
  });
  expect(text()).toContain("Disabled");
  expect(renderer.root.findAllByType("button")).toHaveLength(0);
  await act(async () => renderer.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
