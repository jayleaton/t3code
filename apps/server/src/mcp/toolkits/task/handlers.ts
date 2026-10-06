import { ThreadTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadTaskService from "../../../threadTask/ThreadTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { TaskToolkit } from "./tools.ts";

/** The authenticated caller: the invoking thread, or an authorized client acting as the user. */
const readCaller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new ThreadTaskError({
      code: "scope_denied",
      detail: "This credential cannot use tasks.",
    });
  }
  const caller: ThreadTaskService.ThreadTaskCaller =
    scope.thread === undefined
      ? { kind: "user" }
      : { kind: "thread", threadId: scope.thread.threadId };
  return { caller, tasks: yield* ThreadTaskService.ThreadTaskService };
});

export const layer = TaskToolkit.toLayer({
  t3_task_assign: (input) =>
    readCaller.pipe(Effect.flatMap(({ caller, tasks }) => tasks.assign(caller, input))),
  t3_task_read: (input) =>
    readCaller.pipe(Effect.flatMap(({ caller, tasks }) => tasks.read(caller, input))),
  t3_task_update: (input) =>
    readCaller.pipe(Effect.flatMap(({ caller, tasks }) => tasks.update(caller, input))),
  t3_task_watch: (input) =>
    readCaller.pipe(Effect.flatMap(({ caller, tasks }) => tasks.watch(caller, input))),
});
