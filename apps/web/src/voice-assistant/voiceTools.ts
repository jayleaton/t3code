import type { GatewayRuntimePort } from "@t3tools/client-runtime/gateway";
import type { McpGatewayProfile } from "@t3tools/contracts";

export interface VoiceToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export interface VoiceToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * Function declarations offered to the live model. The model never runs code
 * itself; every tool is executed locally against the selected agent, which is
 * what gives it MCP/workspace access on this device.
 */
export const VOICE_TOOL_DECLARATIONS: ReadonlyArray<VoiceToolDeclaration> = [
  {
    name: "run_voice_task",
    description:
      "Delegate a task to the user's configured voice agent. Only call this after restating the task in one short sentence and getting the user's confirmation, especially when any word, name, or identifier could be misheard. The agent reuses one ongoing thread.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The complete instruction for the agent, written plainly with any names spelled out.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_voice_task_status",
    description:
      "Read the current state of the ongoing task. Use when the user asks how something is going.",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Usually omitted; the assistant tracks the one ongoing thread.",
        },
      },
    },
  },
  {
    name: "stop_voice_task",
    description: "Stop the agent's current work on the ongoing task.",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Usually omitted; the assistant tracks the one ongoing thread.",
        },
      },
    },
  },
];

/**
 * Keeps the assistant a voice layer rather than a second agent: terse, grounded,
 * and cautious about acting on a misheard instruction.
 */
export const VOICE_SYSTEM_INSTRUCTION = [
  "You are the voice layer of T3 Code, an assistant that runs coding tasks on the user's machine.",
  "Keep every spoken reply to one or two short sentences. Never read code, diffs, logs, or long text aloud; summarize instead and offer details only if asked.",
  "Before delegating any task, restate it in one short sentence and ask the user to confirm, especially if a word or name might be misheard (for example 'T3 MCP' or 'T3 code').",
  "If the request is unclear, ask a clarifying question instead of guessing.",
  "When the user asks how a task is going, check its status and summarize in one sentence; never read the agent's message verbatim unless the user asks for the full text.",
  "Never claim an outcome you have not read from a tool result.",
].join(" ");

export interface VoiceToolDependencies {
  readonly getPort: () => GatewayRuntimePort | null;
  readonly getEnvironmentId: () => string | null;
  readonly getProfile: () => McpGatewayProfile | null;
  /** The project to create the delegated thread in, or null when none exists. */
  readonly resolveProjectId: () => string | null;
  /** The single thread the voice agent reuses across tasks, if one exists. */
  readonly getThreadId: () => string | null;
  readonly storeThreadId: (threadId: string) => void;
  readonly newThreadId: () => string;
  readonly newMessageId: () => string;
  readonly newRequestId: () => string;
}

const stringArg = (args: unknown, key: string): string | null => {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Executes the model's tool calls against one persistent agent thread, so the
 * agent keeps context across voice exchanges. Results are deliberately bounded:
 * the model only gets a short status summary, which is what keeps spoken
 * replies concise instead of regurgitating whole transcripts.
 */
export function createVoiceToolHandler(dependencies: VoiceToolDependencies) {
  let lastThreadId: string | null = null;

  const knownThreadId = (): string | null => lastThreadId ?? dependencies.getThreadId();

  return async function handleVoiceToolCall(call: VoiceToolCall): Promise<unknown> {
    const port = dependencies.getPort();
    const environmentId = dependencies.getEnvironmentId();
    const profile = dependencies.getProfile();
    if (port === null || environmentId === null || profile === null) {
      return {
        error:
          "No voice agent is configured. Choose one in Settings, Voice assistant, before delegating tasks.",
      };
    }

    if (call.name === "run_voice_task") {
      const prompt = stringArg(call.args, "prompt");
      if (prompt === null) return { error: "A task prompt is required." };
      const projectId = dependencies.resolveProjectId();
      if (projectId === null) {
        return { error: "Add a project on this environment before delegating tasks." };
      }

      // Reuse the one voice thread; only create when none exists or it is gone.
      let threadId = knownThreadId();
      if (threadId !== null) {
        try {
          await port.getThread(environmentId, threadId);
        } catch {
          threadId = null;
        }
      }
      try {
        if (threadId === null) {
          threadId = dependencies.newThreadId();
          await port.createThread({
            environmentId,
            projectId,
            threadId,
            title: "Voice assistant",
            requestId: dependencies.newRequestId(),
            profileSelection: {
              profileId: profile.profileId,
              revision: profile.revision,
              overrideFields: [],
            },
          });
          dependencies.storeThreadId(threadId);
        }
        await port.sendMessage({
          environmentId,
          threadId,
          text: prompt,
          messageId: dependencies.newMessageId(),
          requestId: dependencies.newRequestId(),
        });
        lastThreadId = threadId;
        return {
          status: "accepted",
          threadId,
          agent: profile.name,
          note: "The agent started the task. Say one short sentence that it is underway; do not read this back.",
        };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not start the task." };
      }
    }

    if (call.name === "get_voice_task_status") {
      const threadId = stringArg(call.args, "threadId") ?? knownThreadId();
      if (threadId === null) return { error: "No task has been started yet." };
      try {
        const thread = record(await port.getThread(environmentId, threadId));
        const messages = Array.isArray(thread["messages"]) ? thread["messages"] : [];
        const lastAssistant = [...messages]
          .reverse()
          .map(record)
          .find((message) => message["role"] === "assistant");
        const text = lastAssistant?.["text"];
        return {
          threadId,
          status: thread["status"] ?? "unknown",
          hasPendingApprovals: thread["hasPendingApprovals"] === true,
          hasPendingUserInput: thread["hasPendingUserInput"] === true,
          lastAgentMessage: typeof text === "string" ? text.slice(0, 600) : null,
          note: "Summarize in one or two spoken sentences. Do not read the message verbatim unless asked.",
        };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not read the task." };
      }
    }

    if (call.name === "stop_voice_task") {
      const threadId = stringArg(call.args, "threadId") ?? knownThreadId();
      if (threadId === null) return { error: "No task has been started yet." };
      try {
        await port.controlThread({
          environmentId,
          threadId,
          action: "stop",
          requestId: dependencies.newRequestId(),
          messageId: dependencies.newMessageId(),
        });
        return { status: "stop-requested", threadId };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not stop the task." };
      }
    }

    return { error: `Unsupported tool: ${call.name}.` };
  };
}
