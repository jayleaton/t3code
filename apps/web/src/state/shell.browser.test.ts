import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createAllEnvironmentShellsBootstrappedAtom } from "./shell";

const studio = EnvironmentId.make("env-studio");
const laptop = EnvironmentId.make("env-laptop");

const entry = (environmentId: EnvironmentId): ConnectionCatalogEntry => ({
  target: new BearerConnectionTarget({ environmentId, label: environmentId, connectionId: "c" }),
  profile: Option.none(),
  enabled: true,
});
const connecting: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connecting",
  attempt: 1,
};

describe("allEnvironmentShellsBootstrappedAtom", () => {
  it("does not wait on a network member that is still opening", () => {
    const registry = AtomRegistry.make();
    const members = Atom.make<ReadonlySet<EnvironmentId>>(new Set<EnvironmentId>());
    const bootstrapped = createAllEnvironmentShellsBootstrappedAtom({
      catalogAtom: Atom.make(() =>
        Option.some({
          isReady: true,
          entries: new Map([
            [studio, entry(studio)],
            [laptop, entry(laptop)],
          ]),
        }),
      ),
      hasSnapshotAtom: (environmentId) => Atom.make(environmentId === studio),
      connectionAtom: () => Atom.make(connecting),
      networkMemberIdsAtom: members,
    });

    // A saved environment the user added still holds the sidebar while it connects.
    expect(registry.get(bootstrapped)).toBe(false);
    registry.set(members, new Set([laptop]));
    expect(registry.get(bootstrapped)).toBe(true);
  });
});
