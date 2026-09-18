import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import * as Effect from "effect/Effect";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Voice provider credentials are owned by a specific environment's secret
 * store. The client always names the owning environment explicitly — it never
 * reuses whichever agent environment happens to be selected in chat — so every
 * atom here is keyed by the environment the user picked in the Providers panel.
 */
export function createVoiceAssistantEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();

  // A monotonically increasing per-environment signal restarts the config read
  // after a mutation, so the panel never shows a stale configured/test state.
  const refreshes = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`voice-provider-refresh:${environmentId}`)),
  );
  const signalRefresh = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    registry.update(refreshes(environmentId), (value) => value + 1);
  };

  const providerConfig = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:voice:provider-config",
    tag: WS_METHODS.voiceGetProviderConfig,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId }) => refreshes(environmentId),
  });

  const liveSessionCredential = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:voice:live-session-credential",
    tag: WS_METHODS.voiceGetLiveSessionCredential,
    // Credentials are short-lived in spirit; never reuse across mounts.
    staleTimeMs: 0,
    idleTtlMs: 60_000,
  });

  const mutationOptions = {
    scheduler: commandScheduler,
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
    },
    onSettled: (
      target: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.sync(() => signalRefresh(registry, target.environmentId)),
  };

  return {
    providerConfig,
    liveSessionCredential,
    setProviderKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:set-provider-key",
      tag: WS_METHODS.voiceSetProviderKey,
      ...mutationOptions,
    }),
    removeProviderKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:remove-provider-key",
      tag: WS_METHODS.voiceRemoveProviderKey,
      ...mutationOptions,
    }),
    testProviderKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:test-provider-key",
      tag: WS_METHODS.voiceTestProviderKey,
      ...mutationOptions,
    }),
  };
}

export type VoiceAssistantEnvironmentAtoms = ReturnType<
  typeof createVoiceAssistantEnvironmentAtoms
>;
