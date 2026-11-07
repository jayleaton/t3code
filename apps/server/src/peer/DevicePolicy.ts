import {
  type AuthMcpClientAccess,
  DEFAULT_TAILNET_DEVICES_SETTINGS,
  DevicePolicyEntry,
  type EnvironmentId,
  TailnetDeviceAccess,
  TailnetDevicesError,
  TailnetDevicesSettings,
  type TailnetDevicesUpdateSettingsInput,
  TailnetHlc,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const compareStamps = (a: TailnetHlc, b: TailnetHlc): number =>
  a.wallMs !== b.wallMs
    ? a.wallMs - b.wallMs
    : a.counter !== b.counter
      ? a.counter - b.counter
      : a.node < b.node
        ? -1
        : a.node > b.node
          ? 1
          : 0;

const ACCESS_ORDER: ReadonlyArray<AuthMcpClientAccess> = [
  "read-only",
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** The narrower of two access levels. */
export const narrowerAccess = (a: AuthMcpClientAccess, b: AuthMcpClientAccess) =>
  ACCESS_ORDER.indexOf(a) <= ACCESS_ORDER.indexOf(b) ? a : b;

/**
 * The policy after taking `incoming`: each device keeps its latest write, so
 * any order of the same writes ends in the same policy.
 */
export const mergePolicy = (
  current: ReadonlyMap<EnvironmentId, DevicePolicyEntry>,
  incoming: ReadonlyArray<DevicePolicyEntry>,
): ReadonlyMap<EnvironmentId, DevicePolicyEntry> => {
  const next = new Map(current);
  for (const entry of incoming) {
    const existing = next.get(entry.environmentId);
    if (existing === undefined || compareStamps(entry.updatedAt, existing.updatedAt) > 0) {
      next.set(entry.environmentId, entry);
    }
  }
  return next;
};

interface PolicyRow {
  readonly environment_id: string;
  readonly access: string;
  readonly stamp_json: string;
  readonly updated_by: string;
}

const decodeEntry = Schema.decodeUnknownEffect(DevicePolicyEntry);
const isAccess = Schema.is(TailnetDeviceAccess);
const decodeStamp = Schema.decodeUnknownEffect(Schema.fromJsonString(TailnetHlc));
const encodeStamp = Schema.encodeEffect(Schema.fromJsonString(TailnetHlc));
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(TailnetDevicesSettings));
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(TailnetDevicesSettings));

const storageError = (cause: unknown) =>
  new TailnetDevicesError({
    reason: "storage",
    message: "Device access could not be read or saved here. The server log has details.",
    cause,
  });

/**
 * What each of my tailnet devices may do, and the settings they share. Every
 * device holds a replica; a write here is stamped with a hybrid logical clock
 * and replicas merge last-writer-wins. Only full-access devices' writes count.
 */
export class DevicePolicy extends Context.Service<
  DevicePolicy,
  {
    readonly settings: Effect.Effect<TailnetDevicesSettings>;
    readonly updateSettings: (
      input: TailnetDevicesUpdateSettingsInput,
    ) => Effect.Effect<TailnetDevicesSettings, TailnetDevicesError>;
    readonly entries: Effect.Effect<ReadonlyArray<DevicePolicyEntry>, TailnetDevicesError>;
    /** The access someone set for the device, if anyone did. */
    readonly entryAccess: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<TailnetDeviceAccess>>;
    /** The device's own entry, or the shared default access. */
    readonly accessFor: (environmentId: EnvironmentId) => Effect.Effect<TailnetDeviceAccess>;
    readonly set: (
      environmentId: EnvironmentId,
      access: TailnetDeviceAccess,
    ) => Effect.Effect<DevicePolicyEntry, TailnetDevicesError>;
    /**
     * Takes another device's replica, unless that device may not write policy:
     * revoked or below full access here. Returns the devices it newly revoked.
     */
    readonly merge: (
      sender: EnvironmentId,
      replica: {
        readonly policy: ReadonlyArray<DevicePolicyEntry>;
        readonly settings: TailnetDevicesSettings;
      },
    ) => Effect.Effect<ReadonlyArray<EnvironmentId>, TailnetDevicesError>;
  }
>()("t3/peer/DevicePolicy") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const lastStamp = yield* Ref.make<TailnetHlc | null>(null);
  // Reads, merges and writes of the replica happen one at a time.
  const writes = yield* Semaphore.make(1);

  const settings: DevicePolicy["Service"]["settings"] = sql<{ settings_json: string }>`
    SELECT settings_json FROM tailnet_device_settings WHERE id = 1
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.succeed(DEFAULT_TAILNET_DEVICES_SETTINGS)
        : decodeSettings(rows[0].settings_json),
    ),
    Effect.tapError((cause) => Effect.logWarning("Tailnet device settings unreadable", { cause })),
    Effect.orElseSucceed(() => DEFAULT_TAILNET_DEVICES_SETTINGS),
  );

  const readEntries = sql<PolicyRow>`SELECT * FROM tailnet_device_policy`.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        decodeStamp(row.stamp_json).pipe(
          Effect.flatMap((updatedAt) =>
            decodeEntry({
              environmentId: row.environment_id,
              access: row.access,
              updatedAt,
              updatedBy: row.updated_by,
            }),
          ),
        ),
      ),
    ),
    Effect.mapError(storageError),
  );

  /** Later than every stamp this environment made or has seen, so its next write wins. */
  const observe = (stamps: ReadonlyArray<TailnetHlc | null>) =>
    Ref.update(lastStamp, (last) =>
      stamps.reduce<TailnetHlc | null>(
        (latest, stamp) =>
          stamp !== null && (latest === null || compareStamps(stamp, latest) > 0) ? stamp : latest,
        last,
      ),
    );

  const stamp = Effect.gen(function* () {
    const node = yield* identity.getEnvironmentId;
    const now = yield* Clock.currentTimeMillis;
    return yield* Ref.modify(lastStamp, (last): [TailnetHlc, TailnetHlc] => {
      const next =
        last === null || now > last.wallMs
          ? { wallMs: now, counter: 0, node }
          : { wallMs: last.wallMs, counter: last.counter + 1, node };
      return [next, next];
    });
  });

  // A restart must not stamp earlier than what is already stored.
  yield* Effect.all([readEntries, settings]).pipe(
    Effect.flatMap(([stored, current]) =>
      observe([...stored.map((entry) => entry.updatedAt), current.updatedAt]),
    ),
    Effect.ignore,
  );

  const writeEntry = (entry: DevicePolicyEntry) =>
    encodeStamp(entry.updatedAt).pipe(
      Effect.flatMap(
        (stampJson) => sql`
          INSERT INTO tailnet_device_policy (environment_id, access, stamp_json, updated_by)
          VALUES (${entry.environmentId}, ${entry.access}, ${stampJson}, ${entry.updatedBy})
          ON CONFLICT (environment_id) DO UPDATE SET
            access = excluded.access,
            stamp_json = excluded.stamp_json,
            updated_by = excluded.updated_by
        `,
      ),
      Effect.mapError(storageError),
    );

  const writeSettings = (next: TailnetDevicesSettings) =>
    encodeSettings(next).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO tailnet_device_settings (id, settings_json) VALUES (1, ${json})
          ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json
        `,
      ),
      Effect.mapError(storageError),
    );

  const entryAccess: DevicePolicy["Service"]["entryAccess"] = Effect.fn("DevicePolicy.entryAccess")(
    function* (environmentId) {
      const rows = yield* sql<{ access: string }>`
      SELECT access FROM tailnet_device_policy WHERE environment_id = ${environmentId}
    `.pipe(Effect.orElseSucceed(() => []));
      const stored = rows[0]?.access;
      if (stored === undefined) return Option.none();
      // An unreadable row fails closed.
      return Option.some(isAccess(stored) ? stored : "revoked");
    },
  );

  const accessFor: DevicePolicy["Service"]["accessFor"] = Effect.fn("DevicePolicy.accessFor")(
    function* (environmentId) {
      const entry = yield* entryAccess(environmentId);
      return Option.isSome(entry) ? entry.value : (yield* settings).defaultAccess;
    },
  );

  const set: DevicePolicy["Service"]["set"] = Effect.fn("DevicePolicy.set")(
    function* (environmentId, access) {
      const updatedAt = yield* stamp;
      const entry: DevicePolicyEntry = {
        environmentId,
        access,
        updatedAt,
        updatedBy: updatedAt.node,
      };
      yield* writeEntry(entry);
      return entry;
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const updateSettings: DevicePolicy["Service"]["updateSettings"] = Effect.fn(
    "DevicePolicy.updateSettings",
  )(
    function* (input) {
      const current = yield* settings;
      const updatedAt = yield* stamp;
      const next: TailnetDevicesSettings = {
        autoLink: input.autoLink ?? current.autoLink,
        defaultAccess: input.defaultAccess ?? current.defaultAccess,
        requireCapability: input.requireCapability ?? current.requireCapability,
        updatedAt,
        updatedBy: updatedAt.node,
      };
      yield* writeSettings(next);
      return next;
    },
    (effect) => writes.withPermits(1)(effect),
  );

  const merge: DevicePolicy["Service"]["merge"] = Effect.fn("DevicePolicy.merge")(
    function* (sender, replica) {
      // A revoked device cannot restore itself, and a limited one cannot widen anyone.
      if ((yield* accessFor(sender)) !== "full-access") return [];
      const self = yield* identity.getEnvironmentId;
      // The same holds for each write the sender relays: no device sets its own access,
      // and only a writer full-access here counts.
      const accepted: Array<DevicePolicyEntry> = [];
      for (const entry of replica.policy) {
        if (entry.environmentId === entry.updatedBy) continue;
        if (entry.updatedBy !== self && (yield* accessFor(entry.updatedBy)) !== "full-access") {
          continue;
        }
        accepted.push(entry);
      }
      const stored = yield* readEntries;
      const current = new Map(stored.map((entry) => [entry.environmentId, entry]));
      const next = mergePolicy(current, accepted);
      const newlyRevoked: Array<EnvironmentId> = [];
      for (const [environmentId, entry] of next) {
        if (current.get(environmentId) === entry) continue;
        yield* writeEntry(entry);
        if (entry.access === "revoked" && current.get(environmentId)?.access !== "revoked") {
          newlyRevoked.push(environmentId);
        }
      }
      const ownSettings = yield* settings;
      const incoming = replica.settings;
      const writerCounts =
        incoming.updatedBy !== null &&
        (incoming.updatedBy === self || (yield* accessFor(incoming.updatedBy)) === "full-access");
      if (
        writerCounts &&
        incoming.updatedAt !== null &&
        (ownSettings.updatedAt === null ||
          compareStamps(incoming.updatedAt, ownSettings.updatedAt) > 0)
      ) {
        yield* writeSettings(incoming);
      }
      yield* observe([
        ...accepted.map((entry) => entry.updatedAt),
        writerCounts ? incoming.updatedAt : null,
      ]);
      return newlyRevoked;
    },
    (effect) => writes.withPermits(1)(effect),
  );

  return DevicePolicy.of({
    settings,
    updateSettings,
    entries: readEntries,
    entryAccess,
    accessFor,
    set,
    merge,
  });
});

export const layer = Layer.effect(DevicePolicy, make);
