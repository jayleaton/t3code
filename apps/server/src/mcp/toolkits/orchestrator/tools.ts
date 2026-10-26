import {
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];
// A send to another environment mints its retry key when the caller passes none.
const sendDependencies = [...dependencies, Crypto.Crypto];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the user's T3 Agents (pass an agent's profileId to delegate_task, t3_thread_launch, or create_threads to run work as that agent), plus the V2 provider instances, a short list of their models from the same live catalog as the composer, inherited runtime settings, and app-owned orchestration features available to this caller. The list has the user's favorite and custom models, your own model, every current Codex, Claude, Muse and Grok model, and the first 8 current models of other providers. Other legacy models are left out. omittedModels counts models left out; pass search, such as 'sonnet 4.6', to find them. delegate_task accepts any catalog model, listed or not. For a separate top-level thread in a new or existing worktree, use t3_thread_launch with workspaceStrategy.",
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Needs an agent running inside a T3 thread. Delegate one task, run with only the supplied task prompt and not this thread's conversation; read its result with task_status. With an agent's profileId (orchestrator_capabilities.agents) it runs as that agent in its own child chat: omit target and modes so the agent's settings apply. Explicit target or modes override the agent, and a child never runs with broader modes than this thread's. If a profileId call fails, report the error instead of retrying without the agent. Without profileId it is a short subagent helper inside this thread's run. Use it instead of native subagent tools when they lack the chosen model or model options are requested or inherited (nonempty inheritedOptions in orchestrator_capabilities): native subagents cannot reliably apply T3 model options. For independent T3 delegated review rounds, call delegate_task again with the original brief, prior findings, responses, and unresolved objections in the task prompt, tracking each round by its own taskId with a distinct clientRequestId, stable across retries of that round. For a follow-up that needs the same child's conversation, use t3_thread_send on its childThreadId. isolation:'worktree' gives a separate checkout based on the parent local commit, with project setup completed before the child starts; uncommitted edits are not copied, and omitted isolation shares the parent checkout. Set target.options using advertised IDs, e.g. Claude {effort: 'max', fastMode: true}, Codex {reasoningEffort: 'max', serviceTier: 'priority'}, and check providerInstanceId, model, and options in the result. Provider/model and modes inherit unless overridden. Options inherit only for the same instance and model; explicit entries override individual values and [] or {} clears them. A requested runtimeMode must be one the target provider lists in orchestrator_capabilities runtimeModes; an inherited one steps down to the broadest mode it offers. Leave runtimeMode unset unless the user asks for a supervised child: approval-required and auto-accept-edits make the child wait for a person at each action that needs approval. Prefer mode='async' for long helper work. mode='wait' blocks until completion, a blocking question, a pending approval, or timeoutMs, which bounds only the parent's wait and never cancels the task; after waitTimedOut keep the taskId and read task_status later. Named children send no automatic messages: use mode='wait' or t3_thread_wait, then task_status or t3_thread_read. If hasPendingQuestion, pass threadId=childThreadId to t3_pending_request_list, t3_pending_request_read (with requestId) and t3_pending_request_respond, or ask the user; a named child's question never wakes this thread, so check it when you wait or read. If pendingApproval is set, read the fresh full request in childThreadId before responding, since the record can outlive its provider callback. It grants no approval authority: decisions remain with the child's existing approval holder, pending request tools answer questions only, and the child keeps running. An async profile-less helper's completion wakes this thread, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a task")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Needs an agent running inside a T3 thread. Read a T3-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task, and task_cancel stops those turns too. Turns held in a stopped queue wait for the user and do not count. latestTerminal* provides later non-monitor turn results; latestTerminalSummary and latestTerminalResultContextTransferId are independently null when they exactly repeat summary and resultContextTransferId, respectively. pendingApproval identifies the oldest pending live approval for this task's own unfinished work. Read the fresh full request in childThreadId before responding: the record can outlive its provider callback and grants no approval authority. Decisions remain with the child's existing approval holder. Reading a terminal result acknowledges its automatic parent delivery.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Needs an agent running inside a T3 thread. Stop a T3-owned delegated task and dispose its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, other queued turns are held, pull request watches end, and the tasks it delegated stop too. The task's own queued turn is cancelled, including when held in a stopped queue. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

const WorkflowStopTool = Tool.make("t3_workflow_stop", {
  description:
    "Stop one running Claude workflow in a T3 thread. Use the workflow coordinator's subagentId returned by t3_thread_read with view='activity'. Stops the whole workflow, including its phases and agents. Does not stop the parent thread or other workflows. Individual workflow phases and agents cannot be stopped separately.",
  parameters: OrchestrationV2StopWorkflowInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

const BackgroundWaitTool = Tool.make("t3_background_wait", {
  description:
    "Keep this thread in the user's Working list and out of their inbox while you wait for background work. Start a background command or Monitor first. Call this before you end your turn if you will act on its result when it wakes you. In taskIds, give the ID shown when the task started. The thread stays in Working until the task ends. The user is not told the work is done. Do not mark work you leave running, such as a dev server or watcher. Unmarked commands and monitors never keep the thread in Working. Pass waiting=false to remove the mark. This does not stop the task. IDs that are not running return in unmatched and change nothing. Only Claude threads support this tool. Other providers return an error.",
  parameters: Schema.Struct({
    taskIds: Schema.Array(TrimmedNonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(20),
    ),
    waiting: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    matched: Schema.Array(Schema.String),
    unmatched: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Title, "Wait on background work");

const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent work in the app scheduler that runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings, and you report the returned nextRunAt; {type:'webhook'} runs once per request to a generated URL. A webhook run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). Each value arrives framed as untrusted request data, and $skill, @file or /command mentions inside it do not act. Without a signature, anyone with the URL can trigger a run. For a sender that signs requests, set signature with a secretRef from request_secret, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. filters must all match, e.g. filters:[{path:'headers.x-github-event', op:'equals', value:'pull_request'}, {path:'body.action', op:'in', value:['opened','reopened']}]; ops are equals, notEquals, in, startsWith and exists. A path segment ending in [] fans out over an array: {path:'body.issue.labels[].name', op:'equals', value:'needs more info'} matches when any label has that name, and notEquals only when none does. Webhook dedupe accepts replayKey and coalesceKey templates with coalesceWindowSeconds (10–3600, default 120); replay keys expire after 7 days and coalescing keeps the latest payload in a window measured from its first delivery. The result's webhookUrl is the public URL to give the user; if it is absent, this environment has no T3 Connect managed tunnel, so tell the user to enable T3 Connect remote access rather than sharing a path. Omit projectId for this thread's project. There, runs post into THIS thread by default (bindToCurrentThread=true); use false only when the user wants a fresh top-level thread per run. Elsewhere each run launches a fresh thread. Provider, model, and runtime settings inherit from this thread, or from the project default when there is no calling thread.",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description:
    "List recurring scheduled tasks in a project (omit projectId for the calling thread's project, or every project when there is no calling thread), including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Webhook schedule dedupe accepts replayKey, coalesceKey, and coalesceWindowSeconds (10–3600, default 120) to suppress replays for 7 days and retain the latest payload in each fixed window. Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run. A webhook schedule without filters keeps the stored filters; pass filters to replace them, or filters:[] to clear them.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. schedule_task's signature.secretRef). It works once. Never ask for secrets in chat, and never invent one.",
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Needs an agent running inside a T3 thread. Launch one or more CHILD chats of this thread that share this checkout. A child is a full, separate agent chat with its own context for a separate part of a larger task: it shows inside this thread's card on the Agents board and in the sidebar, keeps its own status, settles on its own, and manages its own subagents. It is not a subagent; to save your own context, use delegate_task without a profileId, or native subagent tools only when they support the chosen model and no model options are requested or inherited. Prefer t3_thread_launch for a single chat, and for independent implementation or a PR stack in its own worktree use t3_thread_launch with workspaceStrategy instead of asking the agent to create a worktree in its prompt. Each entry may set profileId to run as one of the user's agents (its instructions, skills, model, and modes), and may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit from the agent, or from this thread without one. Project, branch, and worktree always inherit and cannot be overridden here.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List T3 threads in a project, newest first. Omit projectId for the calling thread's project. Filter by durable run status, title, or settled state (settled=true lists threads the user or inactivity auto-settlement moved out of the active list), or snoozed state, and paginate with the returned cursor. A snoozed thread wakes early only when it asks for something or fails after snoozing; completed runs and background wakes keep it snoozed. pullRequests lists every pull request linked to each thread; linkedPullRequest is a legacy single link and can be null while pullRequests still has entries. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; T3 Code shows the thread's current title.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read durable state and a paginated timeline from any T3 thread in this environment, or pass environmentId for a thread on another environment (messages view only, over its latest 500 messages; the result carries environmentId). The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this thread's direct app-owned helper acknowledges its automatic completion delivery. Continue with afterPosition=nextPosition. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. The thread also reports its snooze state and, in pullRequests, every linked pull request; linkedPullRequest is a legacy single link and can be null while pullRequests still has entries. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; T3 Code shows the thread's current title.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a T3 thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Update metadata for a thread. Omit threadId to update this thread. Use action='rename' with title, action='regenerate_title' with no extra field, action='link_pull_request' with pullRequest, or action='unlink_pull_request'. Workspace and branch changes are intentionally not supported. clientRequestId makes retries idempotent.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update T3 thread metadata")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to any T3 thread in this environment, or pass environmentId for a thread on another environment, where the message starts the thread or queues behind its turn (no steer or restart). The target cannot have broader permission modes than the caller. Use delegate_task with the full review context and a new clientRequestId for independent review rounds. For a follow-up that needs the same child's conversation, send to its childThreadId. After a profile-less helper's original task completes, a requested follow-up creates a fresh task in that child thread and returns taskId when it starts a turn or restarts a turn without its own task; its completion notifies the parent, and the original result stays unchanged. A steer that joins a running turn returns that turn's task, if it has one. Named children send no automatic parent messages; wait for the child and read its result. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: sendDependencies,
})
  .annotate(Tool.Title, "Send to a T3 thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a T3 thread run to reach a terminal durable state. Pass environmentId for a thread on another environment. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a T3 thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Request interruption of a running turn in any T3 thread in this environment (for a thread on another environment use t3_control_thread with its environmentId). Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a T3 thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  WorkflowStopTool,
  BackgroundWaitTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  RequestSecretTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
);
