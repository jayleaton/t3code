import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Your tailnet devices as one environment sees them, and the changes it can make. */
export function createTailnetDeviceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tailnet-devices:list",
    tag: WS_METHODS.tailnetDevicesList,
    staleTimeMs: 10_000,
  });
  return {
    list,
    setAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:set-access",
      tag: WS_METHODS.tailnetDevicesSetAccess,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:update-settings",
      tag: WS_METHODS.tailnetDevicesUpdateSettings,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(list({ environmentId, input: {} }))),
    }),
    openDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tailnet-devices:open-device",
      tag: WS_METHODS.tailnetDevicesOpenDevice,
    }),
  };
}
