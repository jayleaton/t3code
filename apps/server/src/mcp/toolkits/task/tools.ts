import {
  ThreadTaskAssignInput,
  ThreadTaskError,
  ThreadTaskListResult,
  ThreadTaskReadInput,
  ThreadTaskUpdateInput,
  ThreadTaskView,
  ThreadTaskWatchInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadTaskService from "../../../threadTask/ThreadTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const taskTool = {
  failure: ThreadTaskError,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ThreadTaskService.ThreadTaskService],
};

const TaskAssignTool = Tool.make("t3_task_assign", {
  ...taskTool,
  description:
    "Assign or replace the task of a child chat nested under this chat. The child reports WAITING, INPUT, or DONE against it and you are woken on those transitions and when its turns end. Named children you launch get a task automatically. settleWhenAccepted is standing consent to settle the child after you accept its DONE revision; it is not acceptance.",
  parameters: ThreadTaskAssignInput,
  success: ThreadTaskView,
}).annotate(Tool.Title, "Assign a task");

const TaskReadTool = Tool.make("t3_task_read", {
  ...taskTool,
  description:
    "Read a task: your own as a worker, a child's as its owner, or omit threadId for every task you own or work on. Returns status, revision, needs, evidence, waitingOn, whether that continuation is live, the worker's run state, and acceptance and settlement.",
  parameters: ThreadTaskReadInput,
  success: ThreadTaskListResult,
}).annotate(Tool.Title, "Read tasks");

const TaskUpdateTool = Tool.make("t3_task_update", {
  ...taskTool,
  description:
    "Update a task at expectedRevision. Workers report WAITING (waitingOn: their run, a watched pull request, or a child task), INPUT (needs: the missing decision or dependency; questionRequestId for a pending question), or DONE (evidence required, child tasks accepted). The owner is woken on INPUT, DONE, and a new waitingOn gate, never on summary edits. Owner only: accept=true accepts the current DONE revision once its merge or deployment gates passed; settleWhenAccepted grants or withdraws settlement consent. Any content change reopens the task and clears acceptance.",
  parameters: ThreadTaskUpdateInput,
  success: ThreadTaskView,
}).annotate(Tool.Title, "Update a task");

const TaskWatchTool = Tool.make("t3_task_watch", {
  ...taskTool,
  description:
    "Wait up to timeoutMs (max 60000) for changes to tasks you own or work on after afterCursor, returning as soon as one changes. Omit afterCursor for the current tasks and cursor. Wakes already arrive as messages; use this only when this turn must wait.",
  parameters: ThreadTaskWatchInput,
  success: ThreadTaskListResult,
}).annotate(Tool.Title, "Watch tasks");

export const TaskToolkit = Toolkit.make(
  TaskAssignTool,
  TaskReadTool,
  TaskUpdateTool,
  TaskWatchTool,
);
