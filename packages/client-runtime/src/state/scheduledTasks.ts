import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

/**
 * Scheduled tasks for one environment: the live list plus the commands that
 * change it. Every command re-publishes the list, so callers read results from
 * `tasks` rather than patching local state.
 */
export function createScheduledTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const command = <Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    label: string,
    tag: Tag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:scheduled-tasks:${label}`,
      tag,
      scheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    });
  return {
    tasks: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:scheduled-tasks:list",
      tag: WS_METHODS.subscribeScheduledTasks,
    }),
    create: command("create", WS_METHODS.scheduledTasksCreate),
    update: command("update", WS_METHODS.scheduledTasksUpdate),
    remove: command("delete", WS_METHODS.scheduledTasksDelete),
    runNow: command("run-now", WS_METHODS.scheduledTasksRunNow),
  };
}
