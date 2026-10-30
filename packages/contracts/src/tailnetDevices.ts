import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Tailnet devices are one owner's T3 servers on their tailnet, linked automatically. Another server
 * is "my device" when Tailscale says its node is untagged and owned by the same
 * user. The side that grants access proves that by dialling the requester back,
 * so no inbound header or source address is ever trusted.
 */

/** A hybrid logical clock stamp. Replicated writes merge last-writer-wins by it. */
export const TailnetHlc = Schema.Struct({
  wallMs: NonNegativeInt,
  counter: NonNegativeInt,
  /** The environment that stamped it, which breaks ties. */
  node: EnvironmentId,
});
export type TailnetHlc = typeof TailnetHlc.Type;

/** What a device may do here. `revoked` is a tombstone: no sessions, no handshakes. */
export const TailnetDeviceAccess = Schema.Literals([...AuthMcpClientAccess.literals, "revoked"]);
export type TailnetDeviceAccess = typeof TailnetDeviceAccess.Type;

export const DevicePolicyEntry = Schema.Struct({
  environmentId: EnvironmentId,
  access: TailnetDeviceAccess,
  updatedAt: TailnetHlc,
  /** The device whose user made the change. */
  updatedBy: EnvironmentId,
});
export type DevicePolicyEntry = typeof DevicePolicyEntry.Type;

/** Settings shared by all my tailnet devices, replicated like the policy. */
export const TailnetDevicesSettings = Schema.Struct({
  /** Link my tailnet devices automatically. */
  autoLink: Schema.Boolean,
  /** The access a newly found device gets until someone changes it. */
  defaultAccess: AuthMcpClientAccess,
  /** Only nodes granted the `t3.codes/device` capability count as my devices. */
  requireCapability: Schema.Boolean,
  /** Absent until someone first changes a setting. */
  updatedAt: Schema.NullOr(TailnetHlc),
  updatedBy: Schema.NullOr(EnvironmentId),
});
export type TailnetDevicesSettings = typeof TailnetDevicesSettings.Type;

/** How this environment's outgoing link to a peer was made. */
export const PeerLinkOrigin = Schema.Literals(["tailnet", "paired"]);
export type PeerLinkOrigin = typeof PeerLinkOrigin.Type;

/** A device's identity and the addresses it can be reached at. */
export const TailnetDeviceDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  urls: Schema.Array(TrimmedNonEmptyString),
});
export type TailnetDeviceDescriptor = typeof TailnetDeviceDescriptor.Type;

/** A base64url random value of at least 32 bytes. */
export const TailnetChallenge = TrimmedNonEmptyString.check(Schema.isMinLength(43));
export type TailnetChallenge = typeof TailnetChallenge.Type;

/**
 * Requester to issuer: "link me". The issuer answers only after dialling the
 * requester back, so the result is known when this request returns.
 */
export const TailnetLinkRequest = Schema.Struct({
  requester: TailnetDeviceDescriptor,
  /** The issuer the requester means; another environment refuses. */
  issuerEnvironmentId: EnvironmentId,
  /** Pending on the requester for this issuer only, briefly. */
  challenge: TailnetChallenge,
});
export type TailnetLinkRequest = typeof TailnetLinkRequest.Type;

export const TailnetLinkRefusal = Schema.Literals([
  "disabled",
  "not_my_device",
  "revoked",
  "wrong_issuer",
  "unreachable",
  "descriptor_mismatch",
  "grant_rejected",
  "storage",
]);
export type TailnetLinkRefusal = typeof TailnetLinkRefusal.Type;

export const TailnetLinkResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("granted") }),
  Schema.Struct({ outcome: Schema.Literal("refused"), reason: TailnetLinkRefusal }),
]);
export type TailnetLinkResult = typeof TailnetLinkResult.Type;

/** Issuer to requester, at the address the issuer resolved and verified itself. */
export const TailnetGrant = Schema.Struct({
  challenge: TailnetChallenge,
  issuer: TailnetDeviceDescriptor,
  token: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
  expiresAt: Schema.DateTimeUtc,
});
export type TailnetGrant = typeof TailnetGrant.Type;

export const TailnetGrantResult = Schema.Struct({ accepted: Schema.Boolean });
export type TailnetGrantResult = typeof TailnetGrantResult.Type;

/**
 * Exchanged over a tailnet device session: device hints (each still proven by its own
 * handshake), the policy and the settings. Each side merges what it receives.
 */
export const TailnetDevicesSyncPayload = Schema.Struct({
  from: TailnetDeviceDescriptor,
  devices: Schema.Array(TailnetDeviceDescriptor),
  policy: Schema.Array(DevicePolicyEntry),
  settings: TailnetDevicesSettings,
});
export type TailnetDevicesSyncPayload = typeof TailnetDevicesSyncPayload.Type;

/** A one-time client pairing credential a peer minted for an app, within its policy. */
export const TailnetDeviceClientCredential = Schema.Struct({
  environmentId: EnvironmentId,
  urls: Schema.Array(TrimmedNonEmptyString),
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type TailnetDeviceClientCredential = typeof TailnetDeviceClientCredential.Type;

export const TailnetDeviceStatus = Schema.Literals(["online", "offline", "revoked"]);
export type TailnetDeviceStatus = typeof TailnetDeviceStatus.Type;

/** One of my devices as this environment sees it, merging tailnet devices and paired links. */
export const TailnetDevice = Schema.Struct({
  ...TailnetDeviceDescriptor.fields,
  status: TailnetDeviceStatus,
  /** The policy's access, or the default when nobody set one. */
  access: TailnetDeviceAccess,
  policy: Schema.NullOr(DevicePolicyEntry),
  /** This environment holds a link to the device, and how it was made. */
  outgoing: Schema.NullOr(PeerLinkOrigin),
  /** The device holds a live session here. */
  incoming: Schema.Boolean,
  /** Tailscale's name for the node, when it is on this tailnet. */
  tailnetName: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type TailnetDevice = typeof TailnetDevice.Type;

export const TailnetDevicesSnapshot = Schema.Struct({
  self: TailnetDeviceDescriptor,
  settings: TailnetDevicesSettings,
  devices: Schema.Array(TailnetDevice),
});
export type TailnetDevicesSnapshot = typeof TailnetDevicesSnapshot.Type;

/** Revoke is `access: "revoked"`; restore is setting any other level. */
export const TailnetDeviceSetAccessInput = Schema.Struct({
  environmentId: EnvironmentId,
  access: TailnetDeviceAccess,
});
export type TailnetDeviceSetAccessInput = typeof TailnetDeviceSetAccessInput.Type;

export const TailnetDevicesUpdateSettingsInput = Schema.Struct({
  autoLink: Schema.optionalKey(Schema.Boolean),
  defaultAccess: Schema.optionalKey(AuthMcpClientAccess),
  requireCapability: Schema.optionalKey(Schema.Boolean),
});
export type TailnetDevicesUpdateSettingsInput = typeof TailnetDevicesUpdateSettingsInput.Type;

export const TailnetDeviceOpenInput = Schema.Struct({ environmentId: EnvironmentId });
export type TailnetDeviceOpenInput = typeof TailnetDeviceOpenInput.Type;

export class TailnetDevicesError extends Schema.TaggedError<TailnetDevicesError>()(
  "TailnetDevicesError",
  {
    reason: Schema.Literals([
      "unknown_device",
      "self",
      "revoked",
      "unreachable",
      "forbidden",
      "storage",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
