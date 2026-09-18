import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  ThreadId,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make, foldVoiceExecution, emptyVoiceExecution } from "./VoiceExecution.ts";

const now = "2026-09-18T00:00:00.000Z";
const profile = {
  profileId: "fast",
  name: "Fast",
  revision: 1,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: now,
  updatedAt: now,
};
it.effect("executes with no projects and preserves device session and request identity", () =>
  Effect.gen(function* () {
    const starts: ProviderSessionStartInput[] = [];
    const sends: ProviderSendTurnInput[] = [];
    const stopped = new Set<ThreadId>();
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderService)({
            streamEvents: Stream.never,
            listSessions: () =>
              Effect.succeed(
                starts
                  .filter((s) => !stopped.has(s.threadId))
                  .map((s) => ({
                    threadId: s.threadId,
                    provider: ProviderDriverKind.make("codex"),
                    runtimeMode: s.runtimeMode,
                    status: "ready" as const,
                    createdAt: now,
                    updatedAt: now,
                  })),
              ),
            startSession: (_id, input) =>
              Effect.sync(() => {
                starts.push(input);
                stopped.delete(input.threadId);
                return {
                  threadId: input.threadId,
                  provider: ProviderDriverKind.make("codex"),
                  runtimeMode: input.runtimeMode,
                  status: "ready" as const,
                  createdAt: now,
                  updatedAt: now,
                };
              }),
            sendTurn: (input) =>
              Effect.sync(() => {
                sends.push(input);
                return { threadId: input.threadId, turnId: TurnId.make("turn-1") };
              }),
            interruptTurn: () => Effect.void,
            stopSession: ({ threadId }) =>
              Effect.sync(() => {
                stopped.add(threadId);
              }),
          }),
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              mcpGatewayProfiles: [profile],
            }),
          }),
        ),
      ),
    );
    const command = {
      action: "run" as const,
      sessionId: "device",
      requestId: "one",
      profileId: "fast",
      prompt: "List the available T3 projects",
    };
    expect((yield* service.execute(command)).status).toBe("running");
    yield* service.execute(command);
    const invalidApproval = yield* service
      .execute({ action: "respond", sessionId: "device", requestId: "not-pending", approve: true })
      .pipe(Effect.result);
    expect(invalidApproval._tag).toBe("Failure");
    expect(starts).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(starts[0]?.threadId).toBe("voice:device");
    expect(starts[0]?.cwd).toBeTruthy();
    expect(starts[0]?.providerInstanceId).toBe("codex");
    expect(starts[0]?.agentInstructions).toContain("not a project");
    const busy = yield* service.execute({ ...command, requestId: "two" }).pipe(Effect.result);
    expect(busy._tag).toBe("Failure");
    yield* service.execute({ action: "stop", sessionId: "device" });
    yield* service.execute({ ...command, requestId: "three" });
    expect(starts).toHaveLength(2);
    expect(sends).toHaveLength(2);
    yield* service.execute({ action: "close", sessionId: "device" });
    expect((yield* service.execute({ action: "status", sessionId: "device" })).status).toBe("idle");
  }).pipe(Effect.scoped),
);

const eventBase = {
  eventId: EventId.make("event"),
  threadId: ThreadId.make("voice:device"),
  provider: ProviderDriverKind.make("codex"),
  createdAt: now,
};
it("announces terminal state only with actual provider results and bounds text", () => {
  const state = { ...emptyVoiceExecution("device"), status: "running" as const };
  const delta: ProviderRuntimeEvent = {
    ...eventBase,
    type: "content.delta",
    payload: { streamKind: "assistant_text", delta: "a".repeat(15000) },
  };
  const text = foldVoiceExecution(state, delta);
  expect(text.text).toHaveLength(12000);
  expect(text.revision).toBe(0);
  const result = foldVoiceExecution(text, {
    ...eventBase,
    type: "turn.completed",
    payload: { state: "completed" },
  });
  expect(result.status).toBe("completed");
  expect(result.revision).toBe(1);
  expect(
    foldVoiceExecution(state, {
      ...eventBase,
      type: "session.exited",
      payload: { exitKind: "error" },
    }).status,
  ).toBe("failed");
});

it("keeps stopped tasks stopped when late events arrive and accepts non-streamed final text", () => {
  const stopped = { ...emptyVoiceExecution("device"), status: "stopped" as const };
  expect(
    foldVoiceExecution(stopped, {
      ...eventBase,
      type: "turn.completed",
      payload: { state: "completed" },
    }),
  ).toBe(stopped);
  const running = { ...emptyVoiceExecution("device"), status: "running" as const };
  const final = foldVoiceExecution(running, {
    ...eventBase,
    type: "item.completed",
    payload: { itemType: "assistant_message", detail: "Created the requested thread." },
  });
  expect(final.text).toBe("Created the requested thread.");
});
