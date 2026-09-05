// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  McpEnvironmentGrantMatrix,
  McpGatewayOperationalStatus,
  McpProfileList,
  toggleMcpGatewayGrantForAll,
  updateMcpGatewayGrant,
} from "./McpGatewaySettings";
import type { GatewayStatusSnapshot } from "@t3tools/client-runtime/gateway";
import {
  MCP_GATEWAY_BASELINE_SCOPES,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
} from "../../mcpGatewayState";
import {
  formatMcpGatewayProfileSummary,
  type McpGatewayProfile,
} from "@t3tools/contracts/settings";
import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";

const grants = {
  "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"] as const,
  "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] as const,
};

const environments = [
  {
    environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
    label: "Primary",
    connectionState: "connected",
  },
  {
    environmentId: "2549ba75-2a91-4554-8baa-88e6ae0efa48",
    label: "JJ’s MacBook",
    connectionState: "connected",
  },
];

const andyProfile: McpGatewayProfile = {
  profileId: "profile-andy",
  name: "Andy",
  providerLabel: "Codex",
  modelLabel: "GPT-5.6 Sol",
  reasoningEffort: "medium",
  runtimeMode: "full-access",
  interactionMode: "default",
  revision: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

const codexDriver = "codex" as ProviderDriverKind;

const codexProvider = {
  instanceId: "codex",
  driver: codexDriver,
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "active" },
  checkedAt: "2026-09-04T00:00:00.000Z",
  availability: "available",
  models: [
    { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", isCustom: false },
    { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", isCustom: false },
  ],
} as unknown as ServerProvider;

describe("MCP environment grant matrix", () => {
  it("offers all v3 capabilities while keeping ordinary enable and select-all least privilege", () => {
    expect(MCP_GATEWAY_CONFIGURABLE_SCOPES).toEqual([
      "read",
      "create",
      "send",
      "control",
      "lifecycle",
      "approval",
      "artifact",
      "review",
      "admin",
      "delivery",
    ]);
    expect(MCP_GATEWAY_BASELINE_SCOPES).toEqual(["read", "create", "send"]);
    expect(toggleMcpGatewayGrantForAll({}, environments)[environments[0]!.environmentId]).toEqual([
      "read",
      "create",
      "send",
    ]);
    expect(updateMcpGatewayGrant({}, environments[0]!.environmentId, "admin", true)).toEqual({
      [environments[0]!.environmentId]: ["admin"],
    });
  });

  it("updates scopes by exact registry id without changing other environment grants", () => {
    expect(
      updateMcpGatewayGrant(grants, "2549ba75-2a91-4554-8baa-88e6ae0efa48", "send", true),
    ).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read", "send"],
    });
    expect(
      updateMcpGatewayGrant(
        { "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] },
        "2549ba75-2a91-4554-8baa-88e6ae0efa48",
        "read",
        false,
      ),
    ).toEqual({});
  });

  it("select all turns every visible machine on, then back off", () => {
    const once = toggleMcpGatewayGrantForAll({}, environments);
    expect(once[environments[0]!.environmentId]).toEqual(["read", "create", "send"]);
    expect(once[environments[1]!.environmentId]).toEqual(["read", "create", "send"]);
    const twice = toggleMcpGatewayGrantForAll(once, environments);
    expect(twice).toEqual({});
  });

  it("select all is safe on an empty machine list", () => {
    expect(toggleMcpGatewayGrantForAll({ "gone-env": ["read"] }, [])).toEqual({
      "gone-env": ["read"],
    });
  });

  it("select all does not grant machines outside the visible list", () => {
    const hidden = { "hidden-env": ["read"] as const };
    const partial = { [environments[0]!.environmentId]: ["read"] as const, ...hidden };
    const next = toggleMcpGatewayGrantForAll(partial, environments);
    expect(next["hidden-env"]).toEqual(["read"]);
    expect(next[environments[0]!.environmentId]).toContain("read");
  });

  it("renders machine rows with select all, per-machine dropdown, and no checkbox pile", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={environments}
        grants={{ [environments[0]!.environmentId]: ["read"] }}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Primary");
    expect(markup).toContain("a534b83f-a352-44d8-aedc-c4230c179390");
    expect(markup).toContain("JJ’s MacBook");
    expect(markup).toContain("Select all environments");
    expect(markup).toContain("Mixed selection");
    expect(markup).toContain('aria-label="Access for Primary"');
    expect(markup).toContain('aria-label="Access for JJ’s MacBook"');
    // No per-scope checkbox pile.
    expect(markup).not.toContain("Grant read access to Primary");
  });

  it("renders an all-on selection without an indeterminate marker", () => {
    const full = {
      [environments[0]!.environmentId]: ["read"] as const,
      [environments[1]!.environmentId]: ["read"] as const,
    };
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix environments={environments} grants={full} onChange={vi.fn()} />,
    );
    expect(markup).toContain("All listed machines on");
  });

  it("keeps persisted grants for unregistered environments visible and revocable", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={[]}
        grants={{ "removed-environment": ["read"] }}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Unavailable environment");
    expect(markup).toContain("removed-environment");
    expect(markup).toContain('aria-label="Access for Unavailable environment"');
    expect(markup).toContain('aria-checked="true"');
  });
});

describe("MCP named profiles", () => {
  it("renders a readable profile summary with no instance or model IDs", () => {
    const markup = renderToStaticMarkup(
      <McpProfileList profiles={[andyProfile]} providers={[codexProvider]} onChange={vi.fn()} />,
    );

    expect(markup).toContain("Andy");
    expect(markup).toContain("Codex GPT-5.6 Sol");
    expect(markup).toContain("medium reasoning");
    expect(markup).toContain("Full access");
    expect(markup).toContain('aria-label="Remove Andy profile"');
    expect(markup).toContain('aria-label="Edit Andy profile"');
  });

  it("marks a profile unavailable when its provider or model leaves the catalog", () => {
    const markup = renderToStaticMarkup(
      <McpProfileList profiles={[andyProfile]} providers={[]} onChange={vi.fn()} />,
    );

    expect(markup).toContain("unavailable — re-select");
  });

  it("formats the agent-facing summary as a sentence without IDs", () => {
    const summary = formatMcpGatewayProfileSummary(andyProfile);
    expect(summary).toContain("Andy — Codex GPT-5.6 Sol");
    expect(summary).not.toContain("instance");
    expect(summary).not.toMatch(/gpt-5\.6-sol/);
  });

  it("preserves identity for ordinary edits and renames, and rejects duplicate names", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const bobProfile: McpGatewayProfile = {
      ...andyProfile,
      profileId: "profile-bob",
      name: "Bob",
    };

    const exerciseEdit = async (profiles: ReadonlyArray<McpGatewayProfile>, nextName?: string) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <McpProfileList profiles={profiles} providers={[codexProvider]} onChange={onChange} />,
        );
      });
      await act(async () => {
        (container.querySelector('[aria-label="Edit Andy profile"]') as HTMLButtonElement).click();
      });
      if (nextName !== undefined) {
        await act(async () => {
          const input = container.querySelector('[aria-label="Profile name"]') as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(
            globalThis.HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(input, nextName);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      return { container, root, onChange };
    };

    const ordinary = await exerciseEdit([andyProfile]);
    await act(async () => {
      (ordinary.container.querySelector("button:not([aria-label])") as HTMLButtonElement).click();
    });
    expect(ordinary.onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        profileId: "profile-andy",
        name: "Andy",
        revision: 1,
        createdAt: andyProfile.createdAt,
        updatedAt: andyProfile.updatedAt,
      }),
    ]);
    await act(async () => ordinary.root.unmount());
    ordinary.container.remove();

    const renamed = await exerciseEdit([andyProfile], "Bob");
    const renameButton = [...renamed.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Update Andy"),
    );
    await act(async () => renameButton?.click());
    expect(renamed.onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        profileId: "profile-andy",
        name: "Bob",
        createdAt: andyProfile.createdAt,
      }),
    ]);
    await act(async () => renamed.root.unmount());
    renamed.container.remove();

    const duplicate = await exerciseEdit([andyProfile, bobProfile], "Bob");
    expect(duplicate.container.textContent).toContain("A profile named Bob already exists.");
    const duplicateButton = [...duplicate.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Update Andy"),
    );
    expect(duplicateButton).toHaveProperty("disabled", true);
    await act(async () => duplicateButton?.click());
    expect(duplicate.onChange).not.toHaveBeenCalled();
    await act(async () => duplicate.root.unmount());
    duplicate.container.remove();
  });

  it("provider and model pickers come from the live provider catalog", () => {
    const markup = renderToStaticMarkup(
      <McpProfileList profiles={[]} providers={[codexProvider]} onChange={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Profile provider"');
    expect(markup).toContain('aria-label="Profile model"');
    expect(markup).toContain('aria-label="Profile reasoning effort"');
    expect(markup).toContain('aria-label="Profile runtime mode"');
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

  it("renders truthful sidecar values and safe delivery inventory", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const onRefresh = vi.fn();
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
    await act(async () => {
      root.render(
        <McpGatewayOperationalStatus
          state="running"
          snapshot={snapshot}
          labels={{ "env-safe": "Disposable fixture" }}
          onRefresh={onRefresh}
        />,
      );
    });
    expect(container.textContent).toContain("Cursor 41; retained 35; oldest 7");
    expect(container.textContent).toContain("sub-safe — active; cursor 40; 1 pending");
    expect(container.textContent).toContain("whk-safe — degraded; cursor 39; 1 pending, 2 failed");
    expect(container.textContent).not.toContain("http");
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(onRefresh).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("shows disconnected, loading, stale, empty, and permission-needed states", () => {
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="degraded" snapshot={null} onRefresh={vi.fn()} />,
      ),
    ).toContain("disconnected or degraded");
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="connecting" snapshot={null} onRefresh={vi.fn()} />,
      ),
    ).toContain("Loading operational status");
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus
          state="running"
          snapshot={{ ...base, stale: true }}
          onRefresh={vi.fn()}
        />,
      ),
    ).toContain("Status is stale");
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="running" snapshot={base} onRefresh={vi.fn()} />,
      ),
    ).toContain("No readable environments");
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
    expect(
      renderToStaticMarkup(
        <McpGatewayOperationalStatus state="running" snapshot={readOnly} onRefresh={vi.fn()} />,
      ),
    ).toContain("Delivery permission needed");
  });
});
