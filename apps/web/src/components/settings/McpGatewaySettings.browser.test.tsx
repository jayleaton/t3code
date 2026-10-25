import type { GatewayStatusSnapshot } from "@t3tools/client-runtime/gateway";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { MCP_GATEWAY_CONFIGURABLE_SCOPES } from "../../mcpGatewayState";
import { McpEnvironmentGrantMatrix, McpGatewayOperationalStatus } from "./McpGatewaySettings";

const environments = [
  { environmentId: "primary", label: "Primary", connectionState: "connected" },
  { environmentId: "macbook", label: "JJ’s MacBook", connectionState: "connected" },
];

describe("MCP environment grant matrix", () => {
  it("offers an explicit all-capabilities choice for one environment", async () => {
    const onChange = vi.fn();
    const grants = { primary: ["read", "create", "send"] as const, macbook: ["read"] as const };
    await using _screen = await render(
      <McpEnvironmentGrantMatrix environments={environments} grants={grants} onChange={onChange} />,
      { router: false },
    );
    await userEvent.click(page.getByRole("button", { name: "Access for Primary" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "All capabilities" }));
    expect(onChange).toHaveBeenCalledWith({ ...grants, primary: MCP_GATEWAY_CONFIGURABLE_SCOPES });
  });

  it("keeps device transport independent of grants through mixed failures and reconnects", async () => {
    const onChange = vi.fn();
    const mixed = [
      { environmentId: "local", label: "Local", connectionState: "connected" },
      {
        environmentId: "auth",
        label: "Remote auth",
        connectionState: "error",
        failureReason: "authentication" as const,
      },
      {
        environmentId: "schema",
        label: "Remote schema",
        connectionState: "error",
        failureReason: "unsupported" as const,
      },
      {
        environmentId: "socket",
        label: "Remote socket",
        connectionState: "reconnecting",
        failureReason: "transport" as const,
      },
      { environmentId: "pending", label: "Pending", connectionState: "connecting" },
    ];
    await using screen = await render(
      <McpEnvironmentGrantMatrix
        environments={mixed}
        grants={{ auth: ["read"], schema: ["read"], removed: ["read"] }}
        onChange={onChange}
      />,
      { router: false },
    );
    const text = () => screen.container.textContent;
    const access = (label: string) =>
      screen.container.querySelector(`[aria-label="Access for ${label}"]`)?.textContent;
    expect(text()).toContain("1 of 5 registered devices connected");
    expect(text()).toContain("Authentication failed");
    expect(text()).toContain("Incompatible connection");
    expect(text()).toContain("Transport failed");
    expect(text()).toContain("Connecting");
    // A grant for a machine no longer registered stays visible so it can be revoked.
    expect(text()).toContain("Unavailable");
    expect(access("Unavailable environment")).toContain("Access on");
    expect(access("Local")).toContain("Access off");
    expect(access("Remote auth")).toContain("Access on");

    await screen.rerender(
      <McpEnvironmentGrantMatrix
        environments={mixed.map((e) => ({
          ...e,
          connectionState: "connected",
          failureReason: undefined,
        }))}
        grants={{}}
        onChange={onChange}
      />,
    );
    expect(text()).toContain("5 of 5 registered devices connected");
    expect(text()).not.toContain("Authentication failed");
    expect(text()).toContain("Access off");

    await screen.rerender(
      <McpEnvironmentGrantMatrix
        environments={mixed.map((e) => ({
          ...e,
          connectionState: "offline",
          failureReason: undefined,
        }))}
        grants={{ auth: ["read"] }}
        onChange={onChange}
      />,
    );
    expect(text()).toContain("0 of 5 registered devices connected");
    expect(text()).toContain("Disconnected");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MCP gateway operational status", () => {
  const base: GatewayStatusSnapshot = {
    schemaVersion: "3",
    capturedAt: "2026-09-05T00:00:00.000Z",
    live: true,
    stale: false,
    retention: { maxEventsPerEnvironment: 100_000, maxAgeDays: 7 },
    environments: [],
  };

  it("does not mistake a live event store for connected devices or retain revoked read access", async () => {
    const snapshot = {
      ...base,
      environments: [
        {
          environmentId: "remote",
          latestSequence: 41,
          retainedEventCount: 3,
          oldestRetainedSequence: 39,
          deliveryAccess: false,
        },
      ],
    };
    const rows = [{ environmentId: "remote", label: "Remote", connectionState: "offline" }];
    const status = (
      state: "running" | "degraded" | "connecting",
      grants: Record<string, readonly "read"[]>,
    ) => (
      <McpGatewayOperationalStatus
        state={state}
        snapshot={snapshot}
        environments={rows}
        grants={grants}
        onRefresh={vi.fn()}
      />
    );
    await using screen = await render(status("running", { remote: ["read"] }), {
      router: false,
    });
    const text = () => screen.container.textContent;
    expect(text()).toContain("Local gateway bridge: Connected");
    expect(text()).toContain("Device: Disconnected");
    expect(text()).toContain("Event store as of");
    expect(text()).toContain("does not indicate device connectivity");
    expect(text()).toContain("Cursor 41");
    await screen.rerender(status("connecting", { remote: ["read"] }));
    expect(text()).toContain("Local gateway bridge: Connecting");
    expect(text()).not.toContain("Cursor 41");
    await screen.rerender(status("degraded", { remote: ["read"] }));
    expect(text()).toContain("Local gateway bridge: Disconnected");
    expect(text()).not.toContain("Cursor 41");
    await screen.rerender(status("running", {}));
    expect(text()).not.toContain("Cursor 41");
    expect(text()).toContain("No readable environments");
  });

  it("renders truthful sidecar values and safe delivery inventory", async () => {
    const snapshot: GatewayStatusSnapshot = {
      ...base,
      environments: [
        {
          environmentId: "env-safe",
          latestSequence: 41,
          oldestRetainedSequence: 7,
          retainedEventCount: 35,
          deliveryAccess: true,
          subscriptionCount: 1,
          subscriptions: [
            {
              subscriptionId: "sub-safe",
              ackedSequence: 40,
              pendingEventCount: 1,
              status: "active",
            },
          ],
          webhookCount: 1,
          webhooks: [
            {
              webhookId: "whk-safe",
              ackedSequence: 39,
              status: "degraded",
              deliveries: { pending: 1, inFlight: 0, acked: 4, failed: 2 },
            },
          ],
          deliveries: { pending: 1, inFlight: 0, acked: 4, failed: 2 },
          deliveryFailureCount: 2,
        },
      ],
    };
    await using screen = await render(
      <McpGatewayOperationalStatus
        state="running"
        snapshot={snapshot}
        labels={{ "env-safe": "Disposable fixture" }}
        grants={{ "env-safe": ["read", "delivery"] }}
        onRefresh={vi.fn()}
      />,
      { router: false },
    );
    const text = screen.container.textContent;
    expect(text).toContain("Cursor 41; retained 35; oldest 7");
    expect(text).toContain("sub-safe: active; cursor 40; 1 pending");
    expect(text).toContain("whk-safe: degraded; cursor 39; 1 pending, 2 failed");
    expect(text).not.toContain("http");
  });

  it("shows disconnected, loading, stale, empty, and permission-needed states", async () => {
    const readOnly = {
      ...base,
      environments: [
        {
          environmentId: "read-only",
          latestSequence: 0,
          oldestRetainedSequence: null,
          retainedEventCount: 0,
          deliveryAccess: false,
        },
      ],
    } satisfies GatewayStatusSnapshot;
    const cases = [
      ["degraded", null, undefined, "disconnected or degraded"],
      ["connecting", null, undefined, "Loading operational status"],
      ["running", { ...base, stale: true }, undefined, "Status is stale"],
      ["running", base, undefined, "No readable environments"],
      ["running", readOnly, { "read-only": ["read" as const] }, "Delivery permission needed"],
    ] as const;
    await using screen = await render(null, { router: false });
    for (const [state, snapshot, grants, message] of cases) {
      await screen.rerender(
        <McpGatewayOperationalStatus
          state={state}
          snapshot={snapshot}
          {...(grants ? { grants } : {})}
          onRefresh={vi.fn()}
        />,
      );
      expect(screen.container.textContent).toContain(message);
    }
  });
});
