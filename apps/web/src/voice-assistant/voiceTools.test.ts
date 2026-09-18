import { describe, expect, it, vi } from "vite-plus/test";
import type { VoiceExecutionInput, VoiceExecutionSnapshot } from "@t3tools/contracts";
import { createVoiceToolHandler } from "./voiceTools";
const profile = {
  profileId: "fast",
  revision: 1,
  name: "Fast",
  runtimeMode: "auto" as const,
  interactionMode: "default" as const,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};
function setup() {
  let session: string | null = null;
  const port = vi.fn(async (input: VoiceExecutionInput): Promise<VoiceExecutionSnapshot> => ({
    sessionId: input.sessionId,
    revision: 1,
    status: "running",
    text: "",
    pendingRequest: null,
  }));
  const deps = {
    getPort: () => port,
    getProfile: () => profile,
    getSessionId: () => session,
    storeSessionId: (id: string) => {
      session = id;
    },
    newSessionId: () => "local-session",
  };
  return { port, deps, handle: createVoiceToolHandler(deps) };
}
describe("device voice tools", () => {
  it("runs with no project, reuses a device session, and deduplicates calls", async () => {
    const { port, handle } = setup();
    const call = { id: "one", name: "run_voice_task", args: { prompt: "List T3 projects" } };
    await Promise.all([handle(call), handle(call)]);
    await handle({ ...call, id: "two" });
    expect(port).toHaveBeenCalledTimes(2);
    expect(port.mock.calls.map(([input]) => input)).toEqual([
      {
        action: "run",
        sessionId: "local-session",
        requestId: "one",
        profileId: "fast",
        prompt: "List T3 projects",
      },
      {
        action: "run",
        sessionId: "local-session",
        requestId: "two",
        profileId: "fast",
        prompt: "List T3 projects",
      },
    ]);
  });
  it("never dispatches a cancelled command", async () => {
    const { port, handle } = setup();
    const abort = new AbortController();
    abort.abort();
    await handle({ id: "one", name: "run_voice_task", args: { prompt: "do work" } }, abort.signal);
    expect(port).not.toHaveBeenCalled();
  });
  it("reports missing local executor rather than using a remote project", async () => {
    const { deps, port } = setup();
    const handle = createVoiceToolHandler({ ...deps, getPort: () => null });
    expect(
      await handle({ id: "one", name: "run_voice_task", args: { prompt: "open an app" } }),
    ).toMatchObject({ error: expect.stringContaining("this device") });
    expect(port).not.toHaveBeenCalled();
  });
  it("passes actual status and explicit approval decisions through", async () => {
    const { port, handle } = setup();
    await handle({ id: "one", name: "run_voice_task", args: { prompt: "open an app" } });
    await handle({
      id: "two",
      name: "respond_voice_approval",
      args: { requestId: "approval-1", approve: false },
    });
    expect(port).toHaveBeenLastCalledWith({
      action: "respond",
      sessionId: "local-session",
      requestId: "approval-1",
      approve: false,
    });
    await handle({ id: "three", name: "stop_voice_task", args: {} });
    expect(port).toHaveBeenLastCalledWith({ action: "stop", sessionId: "local-session" });
  });
});
