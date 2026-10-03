import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentServerConfigsAtom, serverEnvironment } from "./server";

export interface EnvironmentScheduledTask {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

/**
 * Agent scheduled tasks across connected environments. Tasks without a profile are managed in
 * Settings. Reuses the shared per-environment subscription, which opens only while read.
 */
const agentScheduledTasksAtom = Atom.make((get): ReadonlyArray<EnvironmentScheduledTask> => {
  const tasks: EnvironmentScheduledTask[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.scheduledTasks !== true) continue;
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    for (const task of snapshot?.tasks ?? []) {
      if (task.profileId !== undefined) tasks.push({ environmentId, task });
    }
  }
  return tasks;
}).pipe(Atom.withLabel("web-agent-scheduled-tasks"));

const scheduledTasksSupportedAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom).values()].some(
    (config) => config.environment.capabilities.scheduledTasks === true,
  ),
).pipe(Atom.withLabel("web-scheduled-tasks-supported"));

export function useScheduledTasks(): ReadonlyArray<EnvironmentScheduledTask> {
  return useAtomValue(agentScheduledTasksAtom);
}

export function useScheduledTasksSupported(): boolean {
  return useAtomValue(scheduledTasksSupportedAtom);
}
