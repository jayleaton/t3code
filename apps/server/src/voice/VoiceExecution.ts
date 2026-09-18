import * as NodeOS from "node:os";
import {
  ApprovalRequestId,
  ThreadId,
  VoiceExecutionError,
  type VoiceExecutionInput,
  type VoiceExecutionSnapshot,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveThreadCreateProfile } from "../orchestration/Normalizer.ts";

export const emptyVoiceExecution = (sessionId: string): VoiceExecutionSnapshot => ({
  sessionId,
  revision: 0,
  status: "idle",
  text: "",
  pendingRequest: null,
});

/** Only the voice service folds these events; no orchestration thread or project is created. */
export function foldVoiceExecution(
  state: VoiceExecutionSnapshot,
  event: ProviderRuntimeEvent,
): VoiceExecutionSnapshot {
  if (!["running", "approval", "input"].includes(state.status)) return state;
  switch (event.type) {
    case "content.delta":
      return event.payload.streamKind === "assistant_text"
        ? { ...state, text: (state.text + event.payload.delta).slice(-12000) }
        : state;
    case "item.completed":
      return event.payload.itemType === "assistant_message" && event.payload.detail
        ? { ...state, text: event.payload.detail.slice(-12000) }
        : state;
    case "turn.completed":
      return {
        ...state,
        revision: state.revision + 1,
        status:
          event.payload.state === "completed"
            ? "completed"
            : event.payload.state === "failed"
              ? "failed"
              : "stopped",
        text: event.payload.errorMessage ?? state.text,
        pendingRequest: null,
      };
    case "turn.aborted":
      return { ...state, revision: state.revision + 1, status: "stopped", pendingRequest: null };
    case "request.opened":
      return event.requestId === undefined
        ? state
        : {
            ...state,
            revision: state.revision + 1,
            status: event.payload.requestType === "tool_user_input" ? "input" : "approval",
            pendingRequest: {
              requestId: event.requestId,
              description: event.payload.detail ?? "The agent needs a response to continue.",
              ...(event.payload.args === undefined ? {} : { questions: event.payload.args }),
            },
          };
    case "request.resolved":
      return { ...state, revision: state.revision + 1, status: "running", pendingRequest: null };
    case "session.exited":
      return state.status === "running" || state.status === "approval" || state.status === "input"
        ? {
            ...state,
            revision: state.revision + 1,
            status: "failed",
            text: "The device agent disconnected before finishing.",
            pendingRequest: null,
          }
        : state;
    default:
      return state;
  }
}

export class VoiceExecution extends Context.Service<
  VoiceExecution,
  {
    readonly execute: (
      input: VoiceExecutionInput,
    ) => Effect.Effect<VoiceExecutionSnapshot, VoiceExecutionError>;
    readonly subscribe: (sessionId: string) => Stream.Stream<VoiceExecutionSnapshot>;
  }
>()("t3/voice/VoiceExecution") {}

const isVoiceExecutionError = Schema.is(VoiceExecutionError);

/**
 * Unwrap nested `Error.cause` links, which is how Effect's `UnknownError`
 * carries the value a bare `Effect.try` threw. Without this the user hears
 * "An error occurred in Effect.try" and the actionable reason (a dispatch
 * validation message, a spawn failure, a provider error) is lost.
 */
const describeCause = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  const seen = new Set<unknown>([cause]);
  let message = cause.message;
  let current: unknown = (cause as { readonly cause?: unknown }).cause;
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      if (current.message.length > 0 && !message.includes(current.message)) {
        message = `${message}: ${current.message}`;
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    message = `${message}: ${String(current)}`;
    break;
  }
  return message;
};

export const make = Effect.gen(function* () {
  const provider = yield* ProviderService;
  const catalog = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const states = yield* SubscriptionRef.make<ReadonlyMap<string, VoiceExecutionSnapshot>>(
    new Map(),
  );
  const sessions = new Map<
    string,
    {
      profileId: string;
      requests: Set<string>;
      turnId: string | null;
      retiredTurns: Set<string>;
      stopping: boolean;
    }
  >();
  const lock = yield* Semaphore.make(1);
  const threadId = (id: string) => ThreadId.make(`voice:${id}`);
  const read = (id: string) =>
    SubscriptionRef.get(states).pipe(Effect.map((all) => all.get(id) ?? emptyVoiceExecution(id)));
  const write = (state: VoiceExecutionSnapshot) =>
    SubscriptionRef.update(states, (all) => new Map(all).set(state.sessionId, state));
  yield* provider.streamEvents.pipe(
    Stream.runForEach((event) => {
      if (!event.threadId.startsWith("voice:")) return Effect.void;
      const id = event.threadId.slice(6);
      const session = sessions.get(id);
      if (!session || session.stopping || (event.turnId && session.retiredTurns.has(event.turnId)))
        return Effect.void;
      if (event.type === "turn.started" && event.turnId) session.turnId = event.turnId;
      return SubscriptionRef.update(states, (all) => {
        const state = all.get(id);
        if (!state) return all;
        const next = foldVoiceExecution(state, event);
        return next === state ? all : new Map(all).set(id, next);
      });
    }),
    Effect.forkScoped,
  );

  const stopProvider = Effect.fn("VoiceExecution.stopProvider")(function* (id: string) {
    const session = sessions.get(id);
    if (session) session.stopping = true;
    const live = yield* provider.listSessions();
    if (live.some((session) => session.threadId === threadId(id)))
      yield* provider.stopSession({ threadId: threadId(id) }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            if (session) session.stopping = false;
          }),
        ),
      );
  });
  const execute = Effect.fn("VoiceExecution.execute")(
    function* (input: VoiceExecutionInput) {
      if (input.action === "status") return yield* read(input.sessionId);
      const id = input.sessionId;
      const current = yield* read(id);
      if (input.action === "close") {
        if (sessions.has(id)) yield* stopProvider(id);
        sessions.delete(id);
        yield* SubscriptionRef.update(states, (all) => {
          const next = new Map(all);
          next.delete(id);
          return next;
        });
        return emptyVoiceExecution(id);
      }
      if (input.action === "stop") {
        if (sessions.has(id)) yield* stopProvider(id);
        const next = {
          ...current,
          revision: current.revision + 1,
          status: "stopped" as const,
          pendingRequest: null,
        };
        yield* write(next);
        return next;
      }
      if (input.action === "answer") {
        if (current.status !== "input" || current.pendingRequest?.requestId !== input.requestId)
          return yield* new VoiceExecutionError({ message: "That question is no longer pending." });
        yield* provider.respondToUserInput({
          threadId: threadId(id),
          requestId: ApprovalRequestId.make(input.requestId),
          answers: input.answers,
        });
        return yield* read(id);
      }
      if (input.action === "respond") {
        if (current.status !== "approval" || current.pendingRequest?.requestId !== input.requestId)
          return yield* new VoiceExecutionError({ message: "That approval is no longer pending." });
        yield* provider.respondToRequest({
          threadId: threadId(id),
          requestId: ApprovalRequestId.make(input.requestId),
          decision: input.approve ? "accept" : "decline",
        });
        return yield* read(id);
      }
      if (input.action !== "run") return current;
      const existing = sessions.get(id);
      if (existing?.requests.has(input.requestId)) return current;
      if (
        current.status === "running" ||
        current.status === "approval" ||
        current.status === "input"
      )
        return yield* new VoiceExecutionError({
          message: "The device agent is busy. Stop the current task before starting another.",
        });
      if (existing && existing.profileId !== input.profileId)
        return yield* new VoiceExecutionError({
          message: "Start a new voice conversation to change agents.",
        });
      if (!existing && sessions.size >= 32)
        return yield* new VoiceExecutionError({
          message: "Close an old voice conversation before starting another.",
        });
      const saved = yield* settings.getSettings;
      const profile = saved.mcpGatewayProfiles.find((p) => p.profileId === input.profileId);
      if (!profile)
        return yield* new VoiceExecutionError({
          message: "The voice agent is not available on this device.",
        });
      const providers = yield* catalog.getProviders;
      // A bare Effect.try would collapse every OrchestrationDispatchCommandError
      // from the resolver (stale revision, read-only, unavailable provider or
      // model) into "An error occurred in Effect.try", hiding the actionable
      // reason from the spoken summary. Preserve the thrown message instead.
      const resolved = yield* Effect.try({
        try: () =>
          resolveThreadCreateProfile<Parameters<typeof resolveThreadCreateProfile>[0]>(
            {
              profileSelection: {
                profileId: profile.profileId,
                revision: profile.revision,
                overrideFields: [],
              },
            },
            [profile],
            providers,
          ),
        catch: (cause) =>
          new VoiceExecutionError({
            message: describeCause(cause),
          }),
      });
      if (!resolved.modelSelection || !resolved.runtimeMode || resolved.runtimeMode === "read-only")
        return yield* new VoiceExecutionError({ message: "Choose a model for the voice agent." });
      const runtimeMode = resolved.runtimeMode;
      const modelSelection = resolved.modelSelection;
      const instructions = [
        "You are the voice execution agent on this device. Your working directory is the user's home, not a project.",
        "Use your machine tools for local tasks and T3 MCP to discover and operate on projects and threads across connected environments.",
        "When asked to find a local service or MCP, inspect your available MCP tools, local provider configuration, and listening ports using your machine tools. The injected T3 workspace belongs to this executor; another production T3 instance may be running separately. Do not equate absence from your tool list with a service being offline. Do not expose credentials in your summary.",
        "Changing a T3 project or environment never changes which computer you control. Never claim a tool action succeeded without its result.",
        "Give a short factual result suitable for a spoken summary. Ask plain-text questions if information is missing.",
        profile.systemPrompt ?? "",
      ].join("\n");
      const active = existing ?? {
        profileId: profile.profileId,
        requests: new Set<string>(),
        turnId: null,
        retiredTurns: new Set<string>(),
        stopping: false,
      };
      if (active.turnId) active.retiredTurns.add(active.turnId);
      active.turnId = null;
      active.stopping = false;
      if (active.retiredTurns.size > 20)
        active.retiredTurns.delete(active.retiredTurns.values().next().value!);
      sessions.set(id, active);
      active.requests.add(input.requestId);
      if (active.requests.size > 200)
        active.requests.delete(active.requests.values().next().value!);
      yield* write({
        ...current,
        revision: current.revision + 1,
        status: "running",
        text: "",
        pendingRequest: null,
      });
      yield* Effect.gen(function* () {
        const live = yield* provider.listSessions();
        if (
          !live.some(
            (s) => s.threadId === threadId(id) && s.status !== "closed" && s.status !== "error",
          )
        ) {
          yield* provider.startSession(threadId(id), {
            threadId: threadId(id),
            cwd: NodeOS.homedir(),
            executionScope: "device",
            title: "Device voice assistant",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode,
            agentInstructions: instructions,
          });
        }
        const turn = yield* provider.sendTurn({
          threadId: threadId(id),
          input: input.prompt,
          modelSelection: resolved.modelSelection,
          interactionMode: resolved.interactionMode,
          agentInstructions: instructions,
        });
        active.turnId = turn.turnId;
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const state = yield* read(id);
            yield* write({
              ...state,
              revision: state.revision + 1,
              status: "failed",
              text: describeCause(cause),
            });
            return yield* cause;
          }),
        ),
      );
      return yield* read(id);
    },
    (effect) => lock.withPermit(effect),
    (effect) =>
      Effect.tapError(effect, (cause) =>
        Effect.logWarning("voice.execute failed", { message: describeCause(cause) }),
      ),
    Effect.mapError((cause) =>
      isVoiceExecutionError(cause)
        ? cause
        : new VoiceExecutionError({
            message: describeCause(cause),
          }),
    ),
  );
  return VoiceExecution.of({
    execute,
    subscribe: (id) =>
      SubscriptionRef.changes(states).pipe(
        Stream.map((all) => all.get(id) ?? emptyVoiceExecution(id)),
        Stream.changesWith((a, b) => a.revision === b.revision && a.status === b.status),
      ),
  });
});
export const layer = Layer.effect(VoiceExecution, make);
