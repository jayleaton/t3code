import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Agents come first. The user's T3 Agents (\`agents\` in \`orchestrator_capabilities\`, or \`t3_list_agents\`) are named specialists with their own instructions, skills, model, and modes. When work matches an agent, or the user names one, run it as that agent: pass its \`profileId\` to \`delegate_task\`, \`t3_thread_launch\`, or \`create_threads\`, and omit \`target\`/\`modelSelection\` and modes so the agent's own settings apply. Set them only to deliberately override the agent. Use a bare provider/model target or a plain thread only when no agent fits. Native subagents cannot run as a T3 agent. An agent whose modes are broader than this thread's runs at this thread's modes. If a call with \`profileId\` fails, do not retry without it or fall back to a bare model: report the returned error to the user and let them decide.
- Children and subagents are different. A child is a full agent chat with its own context that you launch to do a separate part of a larger task; it shows inside your card on the Agents board, keeps its own status, and settles on its own. A subagent is a helper inside your own run that saves your context; it shows only in your thread's Lineage panel. Leading other agents does not make your children subagents.
- Launch a child for separate work: \`t3_thread_launch\` (one chat, with its own \`workspaceStrategy\`) or \`create_threads\` (several chats sharing this checkout), passing the agent's \`profileId\`. A \`delegate_task\` run as a named agent (\`profileId\`) is also a child. Wait for its thread with \`t3_thread_wait\` and read it with \`t3_thread_read\`; \`task_status\` also exposes its result. Children never send automatic messages back to their parent.`,
  `- Use a subagent to save your own context: native subagent tools, or \`delegate_task\` without a \`profileId\` for a short helper. Pass \`isolation:"worktree"\` to \`delegate_task\` when a child task needs a separate checkout. Discover agents and current provider/model IDs with \`orchestrator_capabilities\` (pass \`search\` for models it leaves out); a native tool's model list is not the full list of available models. Prefer native subagent tools for same-provider helpers only when they support the chosen model and no model options are requested or inherited; otherwise use \`delegate_task\` with that provider instance and model, including for same-provider or cross-provider work. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it.
- For independent T3 delegated review rounds, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. For a follow-up that needs the same child's conversation, use \`t3_thread_send\` on its \`childThreadId\`.`,
  `- \`schedule_task\` creates persistent timed or webhook-triggered work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text. By default runs return to the current thread, which suits orchestrating: each trigger arrives here and you delegate or dedupe; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time, or the webhook's \`webhookUrl\`.
- When you need a secret from the user (a token, API key, or webhook signing secret), call \`request_secret\` so they enter it privately, then pass the returned \`secretRef\` to the tool that needs it. A \`secretRef\` works once. Never ask for a secret in chat, never invent one, and never repeat one.
- To mention another thread to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.`,
  `### Choose the workspace before starting a new thread

For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\` (\`worktree\`, \`existing_worktree\`, or \`root\`). Omitting workspaceStrategy selects the project root; it does not inherit the caller's worktree. For stacked work, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths.

Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and cannot move a thread already attached to a worktree.`,
  `Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when T3 runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.

### Showing visuals

When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.`,
  `- When model options are requested or the child keeps the parent's provider instance and model with nonempty \`inheritedOptions\` from \`orchestrator_capabilities\`, use \`delegate_task\` even for native-supported models. Native subagents cannot reliably apply T3 model options. Read the selected model's descriptors from \`orchestrator_capabilities\` and put settings in \`target.options\`, not only in the prompt. Do not translate max to high or ignore unsupported settings: report a capability mismatch. Check the returned providerInstanceId, model, and options against the requested selection.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.
`;

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
