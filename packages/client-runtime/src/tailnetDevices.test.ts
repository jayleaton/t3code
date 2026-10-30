import { EnvironmentId, type PeerLinkSummary, type TailnetDevice } from "@t3tools/contracts";
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
