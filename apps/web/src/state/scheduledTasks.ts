import { useAtomValue } from "@effect/atom-react";
import { scheduledTaskTarget, type EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { selectScheduledWakeThreadKeys } from "@t3tools/client-runtime/state/agents";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

export interface EnvironmentScheduledTask {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

/**
 * Unarchived agent scheduled tasks across connected environments, for the Agents board's count.
 * Reuses the shared per-environment subscription, which opens only while read.
 */
const agentScheduledTasksAtom = Atom.make((get): ReadonlyArray<EnvironmentScheduledTask> => {
  const tasks: EnvironmentScheduledTask[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.scheduledTasks !== true) continue;
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    for (const task of snapshot?.tasks ?? []) {
      if (scheduledTaskTarget(task) === "agent" && task.archivedAt == null) {
        tasks.push({ environmentId, task });
      }
    }
  }
  return tasks;
}).pipe(Atom.withLabel("web-agent-scheduled-tasks"));

/**
 * Keys of threads a scheduled task will wake later, so the board reads them as Waiting.
 * Reads every task, profile or not, from the same per-environment subscription.
 */
const scheduledWakeThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const tasks: EnvironmentScheduledTask[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.scheduledTasks !== true) continue;
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    for (const task of snapshot?.tasks ?? []) tasks.push({ environmentId, task });
  }
  return selectScheduledWakeThreadKeys(tasks);
}).pipe(Atom.withLabel("web-scheduled-wake-thread-keys"));

const scheduledTasksSupportedAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom).values()].some(
    (config) => config.environment.capabilities.scheduledTasks === true,
  ),
).pipe(Atom.withLabel("web-scheduled-tasks-supported"));

export function useScheduledTasks(): ReadonlyArray<EnvironmentScheduledTask> {
  return useAtomValue(agentScheduledTasksAtom);
}

export function useScheduledWakeThreadKeys(): ReadonlySet<string> {
  return useAtomValue(scheduledWakeThreadKeysAtom);
}

export function useScheduledTasksSupported(): boolean {
  return useAtomValue(scheduledTasksSupportedAtom);
}
