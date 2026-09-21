import {
  type CommandCodeSettings,
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  commandCodePermissionArgs,
  commandCodeTokenUsage,
  commandCodeToolData,
  decodeCommandCodeFrame,
  type CommandCodeFrame,
} from "../commandCodeProtocol.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { COMMAND_CODE_MCP_MOD } from "../commandCodeMcp.ts";
import { spawnCommandCode } from "../commandCodeProcess.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";
import { buildRuntimeInstructions, withAgentInstructions } from "../RuntimeInstructions.ts";

const PROVIDER = ProviderDriverKind.make("commandcode");
const ResumeCursor = Schema.Struct({ sessionId: Schema.NonEmptyString });
const decodeResume = Schema.decodeUnknownOption(ResumeCursor);
const isRequestError = Schema.is(ProviderAdapterRequestError);
const encodeMcpServers = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        url: Schema.String,
        authorizationHeader: Schema.String,
      }),
    ),
  ),
);
type EventInput = ProviderRuntimeEvent extends infer E
  ? E extends ProviderRuntimeEvent
    ? Omit<E, "eventId" | "provider" | "providerInstanceId" | "createdAt" | "threadId">
    : never
  : never;
interface SessionContext {
  session: ProviderSession;
  instructions: string | undefined;
  nativeId: string | undefined;
  fiber: Fiber.Fiber<void> | undefined;
  turns: ProviderThreadTurnSnapshot[];
}

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (
  settings: CommandCodeSettings,
  options: { instanceId: ProviderInstanceId; environment: NodeJS.ProcessEnv; cwd: string },
) {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const sessions = new Map<ThreadId, SessionContext>();
  const gate = yield* Semaphore.make(1);
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const emit = (context: SessionContext, event: EventInput) =>
    Effect.gen(function* () {
      yield* PubSub.publish(events, {
        ...event,
        eventId: EventId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: context.session.threadId,
        createdAt: yield* now,
      } as ProviderRuntimeEvent);
    });
  const getSession = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    });
  const unsupported = (method: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Command Code headless mode does not support ${method}.`,
      }),
    );
  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const context = yield* getSession(threadId);
      if (turnId && context.session.activeTurnId !== turnId) return;
      if (context.fiber) yield* Fiber.interrupt(context.fiber);
    });
  const stopSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) return;
      // Remove first so a concurrent send cannot resurrect a closing session.
      sessions.delete(threadId);
      if (context.fiber) yield* Fiber.interrupt(context.fiber);
      context.session = { ...context.session, status: "closed", updatedAt: yield* now };
      yield* emit(context, {
        type: "session.exited",
        payload: { reason: "Session stopped", exitKind: "graceful" },
      });
    });
  const stopAll = () => Effect.forEach([...sessions.keys()], stopSession, { discard: true });
  yield* Effect.addFinalizer(() => stopAll());

  const startSession = (input: ProviderSessionStartInput) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const resume =
          input.resumeCursor === undefined ? undefined : decodeResume(input.resumeCursor);
        if (resume?._tag === "None")
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Invalid Command Code resume cursor.",
          });
        yield* stopSession(input.threadId);
        const nativeId = resume?._tag === "Some" ? resume.value.sessionId : undefined;
        const timestamp = yield* now;
        const context: SessionContext = {
          session: {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: input.threadId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? options.cwd,
            model: input.modelSelection?.model ?? "default",
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(nativeId ? { resumeCursor: { sessionId: nativeId } } : {}),
          },
          instructions: input.agentInstructions,
          nativeId,
          fiber: undefined,
          turns: [],
        };
        sessions.set(input.threadId, context);
        yield* emit(context, {
          type: "session.started",
          payload: nativeId ? { resume: { sessionId: nativeId } } : {},
        });
        yield* emit(context, { type: "session.state.changed", payload: { state: "ready" } });
        return context.session;
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* getSession(input.threadId);
        if (context.fiber)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "A Command Code turn is already running.",
          });
        if (!input.input?.trim())
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Command Code requires a prompt.",
          });
        if (input.attachments?.length)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "Command Code headless mode does not accept attachments. Reference files in your prompt instead.",
          });
        const turnId = TurnId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const ready = yield* Deferred.make<string, ProviderAdapterRequestError>();
        const model = input.modelSelection?.model ?? context.session.model ?? "default";
        const effort = input.modelSelection
          ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
          : undefined;
        const args = [
          "--print",
          "--output-format",
          "json",
          "--no-auto-update",
          "--skip-onboarding",
          ...commandCodePermissionArgs(
            context.session.runtimeMode,
            input.interactionMode === "plan",
          ),
          ...(context.nativeId ? ["--resume", context.nativeId] : []),
          ...(model !== "default" ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ];
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const instructions = withAgentInstructions(
          buildRuntimeInstructions({
            harness: "Command Code",
            model,
            reasoningEffort: effort,
            threadMcpTools: mcpSession !== undefined,
          }),
          input.agentInstructions ?? context.instructions,
        );
        const prompt = `${instructions}\n\n${input.input}`;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          model,
          updatedAt: yield* now,
        };
        let result: Extract<CommandCodeFrame, { type: "result" }> | undefined;
        let mcpReady = mcpSession === undefined;
        let textStreamed = false;
        let hasSubagents = false;
        const pendingTools = new Map<string, string>();
        let messageIndex = 0;
        let messageOpen = false;
        const itemId = () => RuntimeItemId.make(`${turnId}:message:${messageIndex}`);
        const captureSession = (sessionId: string) =>
          Effect.gen(function* () {
            if (!sessionId.trim()) return;
            if (context.nativeId && context.nativeId !== sessionId)
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "resume",
                detail: "Command Code resumed a different session than requested.",
              });
            context.nativeId = sessionId;
            context.session = { ...context.session, resumeCursor: { sessionId } };
            yield* Deferred.succeed(ready, sessionId);
          });
        const finishMessage = () =>
          Effect.gen(function* () {
            if (!messageOpen) return;
            yield* emit(context, {
              type: "item.completed",
              turnId,
              itemId: itemId(),
              payload: { itemType: "assistant_message", status: "completed" },
            });
            messageOpen = false;
            messageIndex++;
          });
        const onLine = (line: string) =>
          Effect.gen(function* () {
            if (!line.trim()) return;
            const frame = yield* Effect.try({
              try: () => decodeCommandCodeFrame(line),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "stream",
                  detail:
                    "Command Code returned invalid JSON output. Update the CLI to a version supporting --output-format json.",
                  cause,
                }),
            });
            if (frame.type === "result") {
              result = frame;
              if (frame.sessionId) yield* captureSession(frame.sessionId);
              if (!textStreamed && frame.finalText) {
                messageOpen = true;
                yield* emit(context, {
                  type: "content.delta",
                  turnId,
                  itemId: itemId(),
                  payload: { streamKind: "assistant_text", delta: frame.finalText },
                });
              }
              return;
            }
            const event = frame.event;
            if (event.type === "subagent_progress") hasSubagents = true;
            if (event.type === "t3_mcp_ready") mcpReady = true;
            if (event.type === "t3_mcp_error" || (event.type === "run_start" && !mcpReady))
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "mcp",
                detail:
                  typeof event.message === "string"
                    ? event.message
                    : "Command Code did not load the T3 MCP tools. Update the CLI to a version supporting session mods (--mod).",
              });
            if (event.type === "run_start" && typeof event.sessionId === "string")
              yield* captureSession(event.sessionId);
            if (
              (event.type === "text_delta" || event.type === "thinking_delta") &&
              typeof event.delta === "string"
            ) {
              const thinking = event.type === "thinking_delta";
              if (!thinking) {
                textStreamed = true;
                messageOpen = true;
              }
              yield* emit(context, {
                type: "content.delta",
                turnId,
                itemId: thinking
                  ? RuntimeItemId.make(`${turnId}:reasoning:${messageIndex}`)
                  : itemId(),
                payload: {
                  streamKind: thinking ? "reasoning_text" : "assistant_text",
                  delta: event.delta,
                },
              });
            }
            if (event.type === "tool_queued") yield* finishMessage();
            if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
              const started = event.type === "tool_queued";
              const completed = event.type === "tool_completed";
              const denied = event.type === "tool_denied";
              const failed = event.type === "tool_errored" || event.type === "tool_hook_blocked";
              if (started) pendingTools.set(event.toolCallId, event.toolName);
              if (completed || denied || failed) pendingTools.delete(event.toolCallId);
              if (started || completed || denied || failed)
                yield* emit(context, {
                  type: started ? "item.started" : "item.completed",
                  turnId,
                  itemId: RuntimeItemId.make(`${turnId}:tool:${event.toolCallId}`),
                  payload: {
                    itemType: "dynamic_tool_call",
                    title: event.toolName,
                    status: started
                      ? "inProgress"
                      : denied
                        ? "declined"
                        : failed
                          ? "failed"
                          : "completed",
                    data: {
                      toolName: event.toolName,
                      ...(started
                        ? { input: commandCodeToolData(event.input) }
                        : {
                            output: commandCodeToolData(event.result),
                            error: commandCodeToolData(event.error),
                          }),
                    },
                  },
                });
            }
          });
        const run = Effect.gen(function* () {
          let modArgs: string[] = [];
          if (mcpSession) {
            const directory = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-commandcode-mcp-",
            });
            const modPath = `${directory}/t3-mcp.mjs`;
            yield* fileSystem.writeFileString(modPath, COMMAND_CODE_MCP_MOD);
            modArgs = ["--mod", modPath];
          }
          const child = yield* spawnCommandCode({
            binaryPath: settings.binaryPath,
            args: [...args, ...modArgs],
            cwd: context.session.cwd ?? options.cwd,
            environment: {
              ...McpProviderSession.withAgentDeviceEnvironment(options.environment, mcpSession),
              T3_COMMANDCODE_MCP_SERVERS: encodeMcpServers(
                McpProviderSession.mcpHttpServers(mcpSession),
              ),
            },
            prompt,
          });
          yield* emit(context, { type: "turn.started", turnId, payload: { model } });
          const [, stderr, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(onLine)),
              collectStreamAsString(child.stderr, { maxBytes: 16 * 1024 }),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          if (!result || code !== 0 || result.subtype !== "success")
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn",
              detail:
                result?.error ||
                (result?.subtype === "max_turns"
                  ? "Command Code reached its model-request limit. The session is saved; send a follow-up to continue. Resolve any repeatedly failing or unavailable tool before continuing."
                  : stderr.trim() ||
                    `Command Code exited with code ${code} without a successful result.`),
            });
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.scoped,
        );
        context.fiber = yield* run.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
              const errorMessage =
                Exit.isFailure(exit) && !interrupted ? Cause.pretty(exit.cause) : undefined;
              const state = interrupted
                ? "interrupted"
                : Exit.isFailure(exit)
                  ? "failed"
                  : "completed";
              yield* Deferred.fail(
                ready,
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: errorMessage ?? "Command Code stopped before opening a session.",
                }),
              );
              yield* finishMessage();
              for (const [id, toolName] of pendingTools)
                yield* emit(context, {
                  type: "item.completed",
                  turnId,
                  itemId: RuntimeItemId.make(`${turnId}:tool:${id}`),
                  payload: {
                    itemType: "dynamic_tool_call",
                    title: toolName,
                    status: "failed",
                    detail: "Command Code stopped before this tool completed.",
                  },
                });
              context.turns.push({ id: turnId, items: [] });
              context.session = {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: yield* now,
                ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
              };
              yield* emit(context, { type: "session.state.changed", payload: { state: "ready" } });
              context.fiber = undefined;
              yield* emit(context, {
                type: "turn.completed",
                turnId,
                payload: {
                  state,
                  tokenUsage: commandCodeTokenUsage(result?.usage, hasSubagents),
                  ...(errorMessage ? { errorMessage } : {}),
                  ...(result?.usage ? { usage: result.usage } : {}),
                  ...(result?.stopReason ? { stopReason: result.stopReason } : {}),
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: false }),
          Effect.forkIn(scope),
        );
        const sessionId = yield* Deferred.await(ready).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) =>
            isRequestError(cause)
              ? cause
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: "Command Code did not start a session within 30 seconds.",
                  cause,
                }),
          ),
          Effect.onError(() => (context.fiber ? Fiber.interrupt(context.fiber) : Effect.void)),
        );
        return { threadId: input.threadId, turnId, resumeCursor: { sessionId } };
      }),
    );
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    stopSession,
    stopAll,
    respondToRequest: () => unsupported("interactive approvals"),
    respondToUserInput: () => unsupported("interactive questions"),
    readThread: (threadId) =>
      getSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: [...context.turns] }))),
    rollbackThread: () => unsupported("conversation rollback"),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
