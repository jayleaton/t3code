import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  EnvironmentId,
  type PeerLink,
  type TailnetDeviceAccess,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Membership from "../peer/Membership.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

export { DESKTOP_APP_SUBJECT } from "../auth/PairingGrantStore.ts";

/** A session paired to this server by code, with no identity in the network. */
export const CODE_PAIRED_SUBJECT = "one-time-token";

/** A link this server holds to `environmentId`, at `access`. */
export const storedLink = (environmentId: string, access: AuthMcpClientAccess): PeerLink => ({
  environmentId: EnvironmentId.make(environmentId),
  label: `Machine ${environmentId}`,
  urls: [`https://${environmentId}.example`],
  access,
  origin: "paired",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
});

/**
 * What the broker reads: this server's roster, its stored links and the switch. The roster is
 * empty unless a test writes it, or `self` seeds this machine's own entry; there are no links
 * unless `links` names them.
 */
export const layerDependencies = (
  options: {
    readonly environmentId?: EnvironmentId;
    readonly linksOff?: boolean;
    readonly self?: TailnetDeviceAccess;
    readonly links?: ReadonlyArray<PeerLink>;
  } = {},
) => {
  const environmentId = options.environmentId ?? EnvironmentId.make("here");
  const self = options.self;
  const links = options.links ?? [];
  const peerLinks = Layer.mock(PeerLinks.PeerLinks)({
    enabled: Effect.succeed(options.linksOff !== true),
    stored: Effect.succeed(links),
    get: (id) => Effect.succeed(Option.fromNullishOr(links.find((l) => l.environmentId === id))),
    subscribeChanges: Effect.succeed(Stream.never),
  });
  const base = Membership.layer.pipe(
    Layer.provideMerge(peerLinks),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
    Layer.provideMerge(
      ServerSettings.layerTest({ linkedEnvironmentsEnabled: options.linksOff !== true }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  if (self === undefined) return base;
  const seed = Membership.Membership.pipe(
    Effect.flatMap((membership) =>
      membership.put({ environmentId, label: environmentId, nodeId: null, access: self }),
    ),
    Effect.orDie,
  );
  return Layer.effectDiscard(seed).pipe(Layer.provideMerge(base));
};
