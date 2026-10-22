import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal, type Screen } from "../../../test/render";
import { AgentGatewayStatus } from "./AgentGatewayStatus";
import {
  MCP_GATEWAY_ENABLED_KEY,
  MCP_GATEWAY_STATE_EVENT,
  publishMcpGatewayStartup,
  publishMcpGatewayStatus,
  publishMcpGatewayStatusSnapshot,
  setMcpGatewayRestarter,
  setMcpGatewayStatusRequester,
} from "../../mcpGatewayState";

const restart = vi.fn();
const requestStatus = vi.fn(() => true);
const snapshot = {
  schemaVersion: "3" as const,
  capturedAt: "2026-10-01T00:00:00.000Z",
  live: true,
  stale: false,
  retention: { maxEventsPerEnvironment: 100, maxAgeDays: 7 },
  environments: [],
};

/** An enabled desktop gateway that is running but has not yet reported a live snapshot. */
function gateway({ desktop = true } = {}): Disposable {
  vi.clearAllMocks();
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.use(
    stubGlobal("desktopBridge", desktop ? { getMcpGatewayLaunchConfig: () => ({}) } : undefined),
  );
  localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, "true");
  stack.defer(() => localStorage.removeItem(MCP_GATEWAY_ENABLED_KEY));
  publishMcpGatewayStartup({ phase: "starting" });
  publishMcpGatewayStatus("running");
  publishMcpGatewayStatusSnapshot(null);
  setMcpGatewayRestarter(restart);
  setMcpGatewayStatusRequester(requestStatus);
  stack.defer(() => {
    setMcpGatewayRestarter(null);
    setMcpGatewayStatusRequester(null);
  });
  return stack;
}

const renderStatus = () => render(<AgentGatewayStatus />, { router: false });
const text = (screen: Screen) => screen.container.textContent ?? "";
const restartButton = (screen: Screen) =>
  screen.container.querySelector<HTMLButtonElement>('[aria-label="Restart agent gateway"]');
const clickRestart = (screen: Screen) => act(() => restartButton(screen)!.click());
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("requires a live bridge snapshot and invalidates health on disconnect", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  expect(text(screen)).toContain("Disconnected");
  await act(() => publishMcpGatewayStatusSnapshot(snapshot));
  expect(text(screen)).toContain("Connected");
  expect(restartButton(screen)).toBeNull();
  await act(() => publishMcpGatewayStatus("degraded"));
  expect(text(screen)).toContain("Disconnected");
  expect(restartButton(screen)).not.toBeNull();
});

it("does not treat stale sidecar data as healthy", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await act(() => publishMcpGatewayStatusSnapshot({ ...snapshot, stale: true }));
  expect(text(screen)).toContain("Disconnected");
});

it("waits for live health after restart and prevents duplicate recovery", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await clickRestart(screen);
  expect(restart).toHaveBeenCalledOnce();
  expect(text(screen)).toContain("Recovering");
  expect(restartButton(screen)!.disabled).toBe(true);
  await clickRestart(screen);
  expect(restart).toHaveBeenCalledOnce();
  await act(() => publishMcpGatewayStatus("running"));
  expect(text(screen)).toContain("Recovering");
  await act(() => publishMcpGatewayStatusSnapshot(snapshot));
  expect(text(screen)).toContain("Connected");
  expect(text(screen)).not.toContain("Restarting");
});

it("shows the desktop's startup failure as soon as recovery fails", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await clickRestart(screen);
  await act(() =>
    publishMcpGatewayStartup({
      phase: "failed",
      message: "Desktop MCP gateway failed: State file or configuration mismatch",
    }),
  );
  expect(text(screen)).toContain("State file or configuration mismatch");
  expect(restartButton(screen)!.disabled).toBe(false);
});

it("fails a started gateway that never reports healthy", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await clickRestart(screen);
  // Startup itself may take most of its own budget without counting against health.
  await advance(14_000);
  await act(() => publishMcpGatewayStartup({ phase: "ready" }));
  await advance(14_000);
  expect(text(screen)).toContain("Recovering");
  await advance(1_000);
  expect(text(screen)).toContain("bridge did not report healthy");
  expect(restartButton(screen)!.disabled).toBe(false);
});

it("stops recovering when startup never reports and permits retry without exposing raw errors", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await clickRestart(screen);
  await advance(44_000);
  expect(text(screen)).toContain("Recovering");
  await advance(1_000);
  expect(text(screen)).toContain("Gateway recovery failed");
  expect(restartButton(screen)!.disabled).toBe(false);
  restart.mockImplementationOnce(() => {
    throw new Error("secret-bridge-token");
  });
  await clickRestart(screen);
  expect(text(screen)).toContain("Gateway restart is unavailable");
  expect(text(screen)).not.toContain("secret-bridge-token");
});

it("detects an unresponsive bridge and restores health when replies resume", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await act(() => publishMcpGatewayStatusSnapshot(snapshot));
  await advance(20_000);
  expect(text(screen)).toContain("Gateway did not respond");
  await act(() => publishMcpGatewayStatusSnapshot(snapshot));
  expect(text(screen)).toContain("Connected");
  expect(text(screen)).not.toContain("Gateway did not respond");
});

it("does not offer local desktop recovery in a remote web browser", async () => {
  using _gateway = gateway({ desktop: false });
  await using screen = await renderStatus();
  expect(text(screen)).toContain("Desktop only");
  expect(requestStatus).not.toHaveBeenCalled();
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
});

it("reflects gateway disablement during recovery and cancels health timers on unmount", async () => {
  using _gateway = gateway();
  await using screen = await renderStatus();
  await clickRestart(screen);
  await act(() => {
    localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, "false");
    window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
  });
  expect(text(screen)).toContain("Disabled");
  expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  await screen.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
