import type { VoiceExecutionPort } from "@t3tools/client-runtime/voice-assistant";
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
      "Delegate a task to the user's configured voice agent. Call this immediately for any clear request; do not ask for permission first. The agent runs on this device independently of projects.",
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
      properties: {},
    },
  },
  {
    name: "answer_voice_question",
    description:
      "Answer the device agent's pending structured question using the user's response. Key answers by the question ids returned by get_voice_task_status.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string" }, answers: { type: "object" } },
      required: ["requestId", "answers"],
    },
  },
  {
    name: "respond_voice_approval",
    description:
      "Respond to a pending device-agent approval only after the user explicitly approves or declines it. Never approve on your own.",
    parameters: {
      type: "object",
      properties: { requestId: { type: "string" }, approve: { type: "boolean" } },
      required: ["requestId", "approve"],
    },
  },
  {
    name: "stop_voice_task",
    description: "Stop the agent's current work on the ongoing task.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

/**
 * Keeps the assistant a voice layer rather than a second agent: terse, grounded,
 * and cautious about acting on a misheard instruction.
 */
export const VOICE_SYSTEM_INSTRUCTION = [
  "You are the voice layer of T3 Code. When a device executor is connected, your execution agent can use its machine tools and T3 MCP across projects.",
  "The user speaks English. Interpret their speech as English and respond in English unless they explicitly ask to change languages. Do not infer a language change from an accent, a short utterance, background noise, or an uncertain transcript. Preserve technical names such as T3 and MCP; do not translate them.",
  "Keep every spoken reply to one or two short sentences. Never read code, diffs, logs, or long text aloud; summarize instead and offer details only if asked.",
  "Act immediately on clear requests. Do not ask the user for permission or confirmation before calling run_voice_task.",
  "If speech is unclear, ask a brief clarification in English before executing a task. Do not invent words, translate uncertain audio into another language, or execute a command based on a guess. Silence and background noise are not requests.",
  "When the user asks how a task is going, check its status and summarize in one sentence; never read the agent's message verbatim unless the user asks for the full text.",
  "If a tool reports a pending approval, explain what needs permission and wait for the user before calling respond_voice_approval.",
  "Never claim an outcome you have not read from a tool result.",
  "If execution is unavailable, explain that limitation accurately. It does not mean an MCP server is offline; no MCP check has run. Do not invent reconnection steps.",
].join(" ");

export interface VoiceToolDependencies {
  readonly getPort: () => VoiceExecutionPort | null;
  readonly getProfile: () => McpGatewayProfile | null;
  readonly getSessionId: () => string | null;
  readonly storeSessionId: (sessionId: string) => void;
  readonly newSessionId: () => string;
}

const stringArg = (args: unknown, key: string): string | null => {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

export function createVoiceToolHandler(dependencies: VoiceToolDependencies) {
  const completed = new Map<string, Promise<unknown>>();
  let queue = Promise.resolve<unknown>(undefined);
  async function execute(call: VoiceToolCall, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return { error: "Voice request was cancelled." };
    const port = dependencies.getPort();
    if (!port)
      return {
        error:
          "No compatible local executor is connected on this device. No command or MCP check was run. Use Connect this device in the voice panel to pair with an updated local T3 instance. Simply opening the desktop app does not pair this browser.",
      };
    try {
      let sessionId = dependencies.getSessionId();
      if (call.name === "run_voice_task") {
        const profile = dependencies.getProfile();
        if (!profile) return { error: "Choose a voice agent in Settings." };
        const prompt = stringArg(call.args, "prompt");
        if (!prompt) return { error: "A task prompt is required." };
        if (!sessionId) {
          sessionId = dependencies.newSessionId();
          dependencies.storeSessionId(sessionId);
        }
        const result = await port({
          action: "run",
          sessionId,
          profileId: profile.profileId,
          requestId: call.id,
          prompt,
        });
        return {
          ...result,
          agent: profile.name,
          note: "Report the returned state accurately. Running means accepted, not completed.",
        };
      }
      if (!sessionId) return { error: "No task has been started yet." };
      if (call.name === "get_voice_task_status") return await port({ action: "status", sessionId });
      if (call.name === "stop_voice_task") return await port({ action: "stop", sessionId });
      if (call.name === "answer_voice_question") {
        const requestId = stringArg(call.args, "requestId");
        const answers =
          typeof call.args === "object" && call.args !== null
            ? (call.args as Record<string, unknown>).answers
            : undefined;
        if (!requestId || typeof answers !== "object" || answers === null || Array.isArray(answers))
          return { error: "A pending request id and answers are required." };
        return await port({
          action: "answer",
          sessionId,
          requestId,
          answers: answers as Record<string, unknown>,
        });
      }
      if (call.name === "respond_voice_approval") {
        const requestId = stringArg(call.args, "requestId");
        const approve =
          typeof call.args === "object" && call.args !== null
            ? (call.args as Record<string, unknown>).approve
            : undefined;
        if (!requestId || typeof approve !== "boolean")
          return { error: "An approval request id and decision are required." };
        return await port({ action: "respond", sessionId, requestId, approve });
      }
      return { error: `Unsupported tool: ${call.name}.` };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return (call: VoiceToolCall, signal?: AbortSignal): Promise<unknown> => {
    const prior = completed.get(call.id);
    if (prior) return prior;
    const result = queue.then(() => execute(call, signal));
    queue = result.catch(() => undefined);
    completed.set(call.id, result);
    if (completed.size > 200) completed.delete(completed.keys().next().value!);
    return result;
  };
}
