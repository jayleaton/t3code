import {
  EnvironmentId,
  type PeerLinkSummary,
  type TailnetDevice,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { isTailnetDevicesForbidden, linkedDeviceRows } from "./tailnetDevices.ts";

const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");
const vps = EnvironmentId.make("env-vps");

const device = (environmentId: EnvironmentId, label: string): TailnetDevice => ({
  environmentId,
  label,
  urls: [],
  status: "online",
  access: "full-access",
  policy: null,
  outgoing: "tailnet",
  incoming: true,
  tailnetName: null,
  lastSeenAt: null,
});
const link = (environmentId: EnvironmentId, label: string): PeerLinkSummary => ({
  environmentId,
  label,
  urls: [],
  access: "approval-required",
  origin: "paired",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

describe("linkedDeviceRows", () => {
  it("gives each environment one row, devices first, and marks those this app saved", () => {
    const rows = linkedDeviceRows({
      devices: [device(studio, "Studio"), device(box, "Box")],
      links: [link(vps, "VPS"), link(studio, "studio-01")],
      savedEnvironmentIds: new Set([box, vps]),
    });
    expect(
      rows.map((row) => ({
        id: row.environmentId,
        label: row.label,
        device: row.device !== null,
        link: row.link?.label ?? null,
        savedInApp: row.savedInApp,
      })),
    ).toEqual([
      { id: studio, label: "Studio", device: true, link: "studio-01", savedInApp: false },
      { id: box, label: "Box", device: true, link: null, savedInApp: true },
      { id: vps, label: "VPS", device: false, link: "VPS", savedInApp: true },
    ]);
  });
});

// What `TailnetDevices.list` sends: a paired link, a tailnet device it links to,
// and one that only holds a session here, as JSON on the wire.
const WIRE_SNAPSHOT = {
  self: { environmentId: "env-here", label: "Here", urls: ["https://here.ts.net"] },
  settings: {
    autoLink: true,
    defaultAccess: "full-access",
    requireCapability: false,
    updatedAt: null,
    updatedBy: null,
  },
  devices: [
    {
      environmentId: "env-box",
      label: "Box",
      urls: ["https://box.ts.net"],
      status: "revoked",
      access: "revoked",
      policy: {
        environmentId: "env-box",
        access: "revoked",
        updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
        updatedBy: "env-here",
      },
      outgoing: null,
      incoming: true,
      tailnetName: "box",
      lastSeenAt: null,
    },
    {
      environmentId: "env-studio",
      label: "studio-01",
      urls: ["https://studio-01.ts.net"],
      status: "online",
      access: "full-access",
      policy: null,
      outgoing: "tailnet",
      incoming: true,
      tailnetName: "studio-01",
      lastSeenAt: "2026-10-30T10:00:00.000Z",
    },
    {
      environmentId: "env-vps",
      label: "VPS",
      urls: ["https://vps.example.com"],
      status: "offline",
      access: "approval-required",
      policy: null,
      outgoing: "paired",
      incoming: false,
      tailnetName: null,
      lastSeenAt: null,
    },
  ],
};

const decodeWireSnapshot = Schema.decodeSync(Schema.toCodecJson(TailnetDevicesSnapshot));

describe("linkedDeviceRows over the server's snapshot", () => {
  it("keeps every listed device, joined to the link it came from", () => {
    const snapshot = decodeWireSnapshot(WIRE_SNAPSHOT);
    const rows = linkedDeviceRows({
      devices: snapshot.devices,
      links: [link(vps, "VPS"), link(studio, "studio-01")],
      savedEnvironmentIds: new Set([studio]),
    });
    expect(
      rows.map((row) => [row.environmentId, row.device?.access, row.link !== null, row.savedInApp]),
    ).toEqual([
      [box, "revoked", false, false],
      [studio, "full-access", true, true],
      [vps, "approval-required", true, false],
    ]);
  });
});

describe("isTailnetDevicesForbidden", () => {
  it("hides rows only when the session may not see them", () => {
    expect(isTailnetDevicesForbidden({ _tag: "EnvironmentAuthorizationError" })).toBe(true);
    expect(isTailnetDevicesForbidden({ _tag: "TailnetDevicesError", reason: "forbidden" })).toBe(
      true,
    );
    expect(isTailnetDevicesForbidden({ _tag: "TailnetDevicesError", reason: "unreachable" })).toBe(
      false,
    );
    expect(isTailnetDevicesForbidden(null)).toBe(false);
  });
});
