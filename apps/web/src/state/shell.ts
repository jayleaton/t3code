import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentCatalogState,
  enabledEnvironmentIds,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { networkMembers } from "./networkMembers";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

const NO_SHELL_STATUS_ATOM = Atom.make<EnvironmentShellStatus | null>(null).pipe(
  Atom.withLabel("web-environment-shell-status:none"),
);
const NO_SHELL_SNAPSHOT_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-environment-shell-has-snapshot:none"),
);

export function useEnvironmentShellStatus(
  environmentId: EnvironmentId | null,
): EnvironmentShellStatus | null {
  return useAtomValue(
    environmentId === null ? NO_SHELL_STATUS_ATOM : environmentShell.statusAtom(environmentId),
  );
}

export function useEnvironmentShellHasSnapshot(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_SHELL_SNAPSHOT_ATOM
      : environmentShell.hasSnapshotAtom(environmentId),
  );
}

let previousLiveEnvironmentIds: ReadonlySet<EnvironmentId> = new Set();
/** Environments whose threads reflect the server now, not a cache or a resync in flight. */
export const liveShellEnvironmentIdsAtom = Atom.make((get) => {
  const next = new Set<EnvironmentId>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (get(environmentShell.statusAtom(environmentId)) === "live") next.add(environmentId);
  }
  if (
    next.size === previousLiveEnvironmentIds.size &&
    [...next].every((environmentId) => previousLiveEnvironmentIds.has(environmentId))
  ) {
    return previousLiveEnvironmentIds;
  }
  previousLiveEnvironmentIds = next;
  return next;
}).pipe(Atom.withLabel("web-live-shell-environment-ids"));

/**
 * False while an enabled environment with no cached snapshot is still connecting. A network
 * member opened without a click never holds the sidebar before its first snapshot.
 */
export function createAllEnvironmentShellsBootstrappedAtom(input: {
  readonly catalogAtom: Atom.Atom<Option.Option<EnvironmentCatalogState>>;
  readonly hasSnapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  readonly connectionAtom: (environmentId: EnvironmentId) => Atom.Atom<SupervisorConnectionState>;
  readonly networkMemberIdsAtom: Atom.Atom<ReadonlySet<EnvironmentId>>;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogAtom);
    if (Option.isNone(catalog)) {
      return false;
    }
    const networkMembers = get(input.networkMemberIdsAtom);
    for (const environmentId of enabledEnvironmentIds(catalog.value)) {
      if (get(input.hasSnapshotAtom(environmentId)) || networkMembers.has(environmentId)) {
        continue;
      }
      const connection = get(input.connectionAtom(environmentId));
      if (connectionProjectionPhase(connection) !== "disconnected") {
        return false;
      }
      if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
        return false;
      }
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));
}

let previousNetworkMemberIds: ReadonlySet<EnvironmentId> = new Set();
const networkMemberIdsAtom = Atom.make((get): ReadonlySet<EnvironmentId> => {
  const next = new Set(get(networkMembers.recordsAtom).map((record) => record.environmentId));
  if (
    next.size === previousNetworkMemberIds.size &&
    [...next].every((environmentId) => previousNetworkMemberIds.has(environmentId))
  ) {
    return previousNetworkMemberIds;
  }
  previousNetworkMemberIds = next;
  return next;
}).pipe(Atom.withLabel("web-network-member-ids"));

export const allEnvironmentShellsBootstrappedAtom = createAllEnvironmentShellsBootstrappedAtom({
  catalogAtom: Atom.make((get) => AsyncResult.value(get(environmentCatalog.catalogAtom))),
  hasSnapshotAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)),
  ),
  connectionAtom: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      ),
    ),
  ),
  networkMemberIdsAtom,
});

// Catalog can precede primary discovery; an empty or incomplete catalog cannot prove absence.
function catalogIsComplete(
  catalog: EnvironmentCatalogState,
  requiresPrimaryEnvironment: boolean,
): boolean {
  if (!catalog.isReady || catalog.entries.size === 0) return false;
  return (
    !requiresPrimaryEnvironment ||
    Array.from(catalog.entries.values()).some(
      (entry) => entry.target._tag === "PrimaryConnectionTarget",
    )
  );
}

export function createAllEnvironmentProjectSnapshotsReadyAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly requiresPrimaryEnvironment: boolean;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    if (!catalogIsComplete(catalog, input.requiresPrimaryEnvironment)) return false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return false;
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
}

export const allEnvironmentProjectSnapshotsReadyAtom =
  createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: environmentCatalog.catalogValueAtom,
    shellStateValueAtom: environmentShell.stateValueAtom,
    requiresPrimaryEnvironment: expectsPrimaryEnvironment(),
  });

/** Hosted clients and desktops with the local environment disabled never discover a primary. */
export function expectsPrimaryEnvironment(): boolean {
  return !isHostedStaticApp() && !isLocalEnvironmentDisabled();
}

export const allReachableShellsLiveAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (!catalogIsComplete(catalog, expectsPrimaryEnvironment())) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (shell.status === "live" && Option.isSome(shell.snapshot)) continue;
    const state = AsyncResult.value(get(environmentCatalog.stateAtom(environmentId)));
    if (Option.isNone(state)) return false;
    const connection = state.value;
    const settledOffline =
      connection.phase === "offline" ||
      connection.phase === "blocked" ||
      connection.unreachable === true ||
      (connection.phase === "backoff" && connection.attempt > 2);
    if (!settledOffline) return false;
  }
  return true;
}).pipe(Atom.withLabel("web-all-reachable-shells-live"));
