import type { GatewayRuntimePort } from "@t3tools/client-runtime/gateway";
import { describe, expect, it, vi } from "vite-plus/test";

import { createVoiceToolHandler, type VoiceToolDependencies } from "./voiceTools";

const profile = {
  profileId: "profile-1",
  name: "Fast Agent",
  revision: 3,
  runtimeMode: "auto" as const,
  interactionMode: "default" as const,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

type CreateThreadInput = Parameters<GatewayRuntimePort["createThread"]>[0];
type SendMessageInput = Parameters<GatewayRuntimePort["sendMessage"]>[0];
type ControlThreadInput = Parameters<GatewayRuntimePort["controlThread"]>[0];

function createPort() {
  return {
    createThread: vi.fn(async (_input: CreateThreadInput) => ({
      status: "accepted",
      threadId: "thread-1",
    })),
    sendMessage: vi.fn(async (_input: SendMessageInput) => ({ status: "accepted" })),
    getThread: vi.fn(async () => ({
      id: "thread-1",
      status: "running",
      messages: [{ role: "assistant", text: "working on it" }],
    })),
    controlThread: vi.fn(async (_input: ControlThreadInput) => ({ status: "accepted" })),
  };
}

function createDeps(
  port: ReturnType<typeof createPort>,
  profileOverride: typeof profile | null = profile,
) {
  let sequence = 0;
  let storedThreadId: string | null = null;
  const dependencies: VoiceToolDependencies = {
    getPort: () => port as unknown as GatewayRuntimePort,
    getEnvironmentId: () => "env-1",
    getProfile: () => profileOverride,
    resolveProjectId: () => "project-1",
    getThreadId: () => storedThreadId,
    storeThreadId: (threadId) => {
      storedThreadId = threadId;
    },
    newThreadId: () => `thread-${++sequence}`,
    newMessageId: () => `message-${++sequence}`,
    newRequestId: () => `request-${++sequence}`,
  };
  return dependencies;
}

describe("voice tool handler", () => {
  it("delegates a task to the selected agent and returns a thread id", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port));

    const result = await handle({
      id: "call-1",
      name: "run_voice_task",
      args: { prompt: "add a dark mode toggle to the settings page" },
    });

    expect(port.createThread).toHaveBeenCalledTimes(1);
    const created = port.createThread.mock.calls[0]?.[0];
    expect(created?.environmentId).toBe("env-1");
    expect(created?.projectId).toBe("project-1");
    expect(created?.profileSelection).toEqual({
      profileId: "profile-1",
      revision: 3,
      overrideFields: [],
    });
    expect(port.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      threadId: "thread-1",
      text: "add a dark mode toggle to the settings page",
    });
    expect(result).toMatchObject({ status: "accepted", agent: "Fast Agent" });
  });

  it("reuses one thread across tasks instead of creating a new one each time", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port));

    await handle({ id: "call-1", name: "run_voice_task", args: { prompt: "first task" } });
    await handle({ id: "call-2", name: "run_voice_task", args: { prompt: "second task" } });

    expect(port.createThread).toHaveBeenCalledTimes(1);
    expect(port.sendMessage).toHaveBeenCalledTimes(2);
    expect(port.sendMessage.mock.calls[1]?.[0]).toMatchObject({
      threadId: "thread-1",
      text: "second task",
    });
  });

  it("returns a bounded summary instead of the whole transcript", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port));
    await handle({ id: "call-1", name: "run_voice_task", args: { prompt: "do the thing" } });

    const status = (await handle({ id: "call-2", name: "get_voice_task_status", args: {} })) as {
      lastAgentMessage?: string | null;
      messages?: unknown;
    };

    expect(status.lastAgentMessage).toBe("working on it");
    expect(status.messages).toBeUndefined();
  });

  it("requires a configured agent before delegating", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port, null));

    const result = await handle({ id: "call-1", name: "run_voice_task", args: { prompt: "hi" } });

    expect(port.createThread).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: expect.stringContaining("No voice agent is configured"),
    });
  });

  it("reports status for the most recent task without an explicit id", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port));
    await handle({ id: "call-1", name: "run_voice_task", args: { prompt: "do the thing" } });

    const status = await handle({ id: "call-2", name: "get_voice_task_status", args: {} });

    expect(port.getThread).toHaveBeenCalledWith("env-1", "thread-1");
    expect(status).toMatchObject({ threadId: "thread-1" });
  });

  it("stops the most recent task", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port));
    await handle({ id: "call-1", name: "run_voice_task", args: { prompt: "do the thing" } });

    const stopped = await handle({ id: "call-2", name: "stop_voice_task", args: {} });

    expect(port.controlThread.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "env-1",
      threadId: "thread-1",
      action: "stop",
    });
    expect(stopped).toMatchObject({ status: "stop-requested" });
  });

  it("rejects unknown tools instead of pretending they ran", async () => {
    const port = createPort();
    const handle = createVoiceToolHandler(createDeps(port));

    const result = await handle({ id: "call-1", name: "format_disk", args: {} });

    expect(result).toMatchObject({ error: expect.stringContaining("Unsupported tool") });
  });
});
