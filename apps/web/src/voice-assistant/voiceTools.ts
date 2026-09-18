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
      "Delegate a coding or workspace task to the user's configured voice agent. Use this for any request to inspect, change, run, or create something. Returns a thread id you can report status for.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The complete instruction for the agent, in the user's own words.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_voice_task_status",
    description:
      "Read the current state of a delegated task. Use when the user asks how something is going.",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "The thread id returned by run_voice_task. Omit for the most recent task.",
        },
      },
    },
  },
  {
    name: "stop_voice_task",
    description: "Stop the agent's current work on a delegated task.",
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "The thread id to stop. Omit for the most recent task.",
        },
      },
    },
  },
];

export interface VoiceToolDependencies {
  readonly getPort: () => GatewayRuntimePort | null;
  readonly getEnvironmentId: () => string | null;
  readonly getProfile: () => McpGatewayProfile | null;
  /** The project to create delegated threads in, or null when none exists. */
  readonly resolveProjectId: () => string | null;
  readonly newThreadId: () => string;
  readonly newMessageId: () => string;
  readonly newRequestId: () => string;
}

const stringArg = (args: unknown, key: string): string | null => {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

/**
 * Executes the model's tool calls. Returns a value that is sent back to the
 * model as the function response; it should read like a short status report,
 * because the model turns it into speech.
 */
export function createVoiceToolHandler(dependencies: VoiceToolDependencies) {
  let lastThreadId: string | null = null;

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
      const threadId = dependencies.newThreadId();
      try {
        await port.createThread({
          environmentId,
          projectId,
          threadId,
          title: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
          requestId: dependencies.newRequestId(),
          profileSelection: {
            profileId: profile.profileId,
            revision: profile.revision,
            overrideFields: [],
          },
        });
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
          note: "The agent started the task. Tell the user it is underway and offer to check later.",
        };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not start the task." };
      }
    }

    if (call.name === "get_voice_task_status") {
      const threadId = stringArg(call.args, "threadId") ?? lastThreadId;
      if (threadId === null) return { error: "No task has been started yet." };
      try {
        const thread = await port.getThread(environmentId, threadId);
        return { threadId, thread };
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Could not read the task." };
      }
    }

    if (call.name === "stop_voice_task") {
      const threadId = stringArg(call.args, "threadId") ?? lastThreadId;
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
