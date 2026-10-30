/**
 * The rows the Linked environments section shows: your tailnet devices and
 * this environment's links, one row per environmentId.
 */
import type { EnvironmentId, PeerLinkSummary, TailnetDevice } from "@t3tools/contracts";

export interface LinkedDeviceRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Present when the environment reports it among your devices. */
  readonly device: TailnetDevice | null;
  /** This environment's link to it, from the links list. */
  readonly link: PeerLinkSummary | null;
  /** This app already has it saved, so Open has nothing to add. */
  readonly savedInApp: boolean;
}

/** Your devices in the order the environment lists them, then links to anything else. */
export function linkedDeviceRows(input: {
  readonly devices: ReadonlyArray<TailnetDevice>;
  readonly links: ReadonlyArray<PeerLinkSummary>;
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<LinkedDeviceRow> {
  const links = new Map(input.links.map((link) => [link.environmentId, link] as const));
  const deviceIds = new Set(input.devices.map((device) => device.environmentId));
  return [
    ...input.devices.map((device) => ({
      environmentId: device.environmentId,
      label: device.label,
      device,
      link: links.get(device.environmentId) ?? null,
      savedInApp: input.savedEnvironmentIds.has(device.environmentId),
    })),
    ...input.links
      .filter((link) => !deviceIds.has(link.environmentId))
      .map((link) => ({
        environmentId: link.environmentId,
        label: link.label,
        device: null,
        link,
        savedInApp: input.savedEnvironmentIds.has(link.environmentId),
      })),
  ];
}

/**
 * Whether listing failed because this session may not see devices, which hides
 * the rows, rather than because the server cannot list them yet (older or not
 * yet updated servers), which the UI reports as unavailable.
 */
export function isTailnetDevicesForbidden(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) return false;
  return (
    failure._tag === "EnvironmentAuthorizationError" ||
    (failure._tag === "TailnetDevicesError" &&
      "reason" in failure &&
      failure.reason === "forbidden")
  );
}
