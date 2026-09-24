import { useAtomValue } from "@effect/atom-react";
import { createScheduledTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/scheduled-tasks";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const scheduledTaskEnvironment = createScheduledTaskEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentScheduledTask {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

/**
 * Every scheduled task across connected environments that run them. Each
 * environment's stream opens only while something reads this atom.
 */
const allScheduledTasksAtom = Atom.make((get): ReadonlyArray<EnvironmentScheduledTask> => {
  const tasks: EnvironmentScheduledTask[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.scheduledTasks !== true) continue;
    const result = get(scheduledTaskEnvironment.tasks({ environmentId, input: {} }));
    for (const task of Option.getOrElse(AsyncResult.value(result), () => [])) {
      tasks.push({ environmentId, task });
    }
  }
  return tasks;
}).pipe(Atom.withLabel("web-scheduled-tasks"));

const scheduledTasksSupportedAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom).values()].some(
    (config) => config.environment.capabilities.scheduledTasks === true,
  ),
).pipe(Atom.withLabel("web-scheduled-tasks-supported"));

export function useScheduledTasks(): ReadonlyArray<EnvironmentScheduledTask> {
  return useAtomValue(allScheduledTasksAtom);
}

export function useScheduledTasksSupported(): boolean {
  return useAtomValue(scheduledTasksSupportedAtom);
}
