import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createThread,
  interruptThreadTurn,
  respondToThreadApproval,
  startThreadTurn,
  stopThreadSession,
} from "../operations/commands.ts";
import { request, subscribe } from "../rpc/client.ts";
import type { GatewayRuntimeEvent, GatewayRuntimeEventSource, GatewayRuntimePort } from "./port.ts";

export interface GatewayEffectRuntime {
  runPromise<A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>): Promise<A>;
}

class GatewayThreadRetryError extends Data.TaggedError("GatewayThreadRetryError")<{
  readonly message: string;
}> {}

export function createGatewayRuntimePortFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto>,
): GatewayRuntimePort {
  return createGatewayRuntimePort({
    runPromise: (effect) => Effect.runPromiseWith(context)(effect),
  });
}

function targetKind(tag: string): string {
  return tag.replace(/ConnectionTarget$/, "").toLowerCase();
}

const shellSnapshot = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(
          (item) => (Option.getOrThrow(item) as { snapshot: OrchestrationShellSnapshot }).snapshot,
        ),
      ),
    );
  });

const threadSnapshot = (environmentId: EnvironmentId, threadId: ThreadId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry.run(
      environmentId,
      subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(
          (item) =>
            (Option.getOrThrow(item) as { snapshot: OrchestrationThreadDetailSnapshot }).snapshot,
        ),
      ),
    );
  });

function gatewayEventFromOrchestration(
  environmentId: EnvironmentId,
  event: OrchestrationEvent,
): GatewayRuntimeEvent {
  const payload = event.payload as unknown as Record<string, unknown>;
  const activity =
    event.type === "thread.activity-appended" &&
    typeof payload.activity === "object" &&
    payload.activity !== null
      ? (payload.activity as Record<string, unknown>)
      : undefined;
  const activityKind = typeof activity?.kind === "string" ? activity.kind : undefined;
  const type =
    event.type === "thread.created" || event.type === "thread.turn-start-requested"
      ? "thread.started"
      : activityKind === "approval.requested"
        ? "approval.requested"
        : activityKind === "user-input.requested"
          ? "input.requested"
          : activityKind === "turn.completed"
            ? "thread.completed"
            : activityKind === "turn.failed" || activityKind === "error"
              ? "thread.failed"
              : activityKind === "turn.interrupted"
                ? "thread.interrupted"
                : event.aggregateKind === "thread"
                  ? "thread.progress"
                  : event.type;
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    environmentId,
    type,
    ...(event.aggregateKind === "thread" ? { threadId: event.aggregateId } : {}),
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
    data: {
      serverSequence: event.sequence,
      serverEventType: event.type,
      payload,
    },
  };
}

export function createGatewayRuntimeEventSourceFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto>,
): GatewayRuntimeEventSource {
  return {
    subscribe: (listener, subscription) => {
      const allowedEnvironmentIds = new Set(subscription.environmentIds);
      const stream = Stream.unwrap(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return Stream.concat(
            Stream.fromEffect(SubscriptionRef.get(registry.entries)),
            SubscriptionRef.changes(registry.entries),
          ).pipe(
            Stream.switchMap((entries) =>
              Stream.mergeAll(
                [...entries.keys()]
                  .filter((environmentId) => allowedEnvironmentIds.has(environmentId))
                  .map((environmentId) =>
                    registry
                      .runStream(
                        environmentId,
                        subscribe(ORCHESTRATION_WS_METHODS.subscribeEvents, {
                          afterSequence:
                            subscription.afterSequenceByEnvironment[environmentId] ?? 0,
                        }),
                      )
                      .pipe(
                        Stream.map((event) => gatewayEventFromOrchestration(environmentId, event)),
                        Stream.catchCause(() => Stream.empty),
                      ),
                  ),
                { concurrency: "unbounded" },
              ),
            ),
          );
        }),
      );
      const fiber = Effect.runForkWith(context)(
        Stream.runForEach(stream, (event) => Effect.sync(() => listener(event))),
      );
      return () => fiber.interruptUnsafe();
    },
  };
}

export function createGatewayRuntimePort(runtime: GatewayEffectRuntime): GatewayRuntimePort {
  const run = <A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>) =>
    runtime.runPromise(effect);

  return {
    listEnvironments: () =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const entries = yield* SubscriptionRef.get(registry.entries);
          return yield* Effect.forEach([...entries.values()], (entry) =>
            registry.state(entry.target.environmentId).pipe(
              Effect.map((state) => ({
                environmentId: entry.target.environmentId,
                label: entry.target.label,
                targetKind: targetKind(entry.target._tag),
                connectionState: state.phase,
              })),
            ),
          );
        }),
      ),
    getEnvironmentStatus: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(rawEnvironmentId);
          const state = yield* registry.state(environmentId);
          return { environmentId, ...state } as Record<string, unknown>;
        }),
      ),
    listProjects: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.projects as ReadonlyArray<Record<string, unknown>>,
        snapshotAt: snapshot.updatedAt,
      })),
    listThreads: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.threads as ReadonlyArray<Record<string, unknown>>,
        snapshotAt: snapshot.updatedAt,
      })),
    getThread: (rawEnvironmentId, rawThreadId) =>
      run(threadSnapshot(EnvironmentId.make(rawEnvironmentId), ThreadId.make(rawThreadId))).then(
        (snapshot) => snapshot.thread as Record<string, unknown>,
      ),
    createAssetUrl: (rawEnvironmentId, resource) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const typedResource =
            resource._tag === "attachment"
              ? resource
              : { ...resource, threadId: ThreadId.make(resource.threadId) };
          return yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.assetsCreateUrl, { resource: typedResource }),
          );
        }),
      ),
    getPullRequest: (rawEnvironmentId, ref) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return (yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.pullRequestsDetail, {
              ...ref,
              projectId: ProjectId.make(ref.projectId),
            }),
          )) as Record<string, unknown>;
        }),
      ),
    getPullRequestActivity: (rawEnvironmentId, ref) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return (yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.pullRequestsActivity, {
              ...ref,
              projectId: ProjectId.make(ref.projectId),
            }),
          )) as Record<string, unknown>;
        }),
      ),
    createThread: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            createThread({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              projectId: ProjectId.make(input.projectId),
              title: input.title,
              modelSelection: {
                ...input.modelSelection,
                instanceId: ProviderInstanceId.make(input.modelSelection.instanceId),
              },
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: null,
              worktreePath: null,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    sendMessage: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const shell = yield* shellSnapshot(environmentId);
          const thread = shell.threads.find((candidate) => candidate.id === threadId);
          if (thread === undefined) throw new Error(`Thread ${input.threadId} was not found.`);
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            environmentId,
            startThreadTurn({
              commandId: CommandId.make(input.requestId),
              threadId,
              message: {
                messageId: MessageId.make(input.messageId),
                role: "user",
                text: input.text,
                attachments: [],
              },
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
            messageId: input.messageId,
          };
        }),
      ),
    controlThread: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const registry = yield* EnvironmentRegistry;
          const detail = yield* threadSnapshot(environmentId, threadId);
          const thread = detail.thread as OrchestrationThread;
          const stop = (requestId = input.requestId) =>
            registry.run(
              environmentId,
              stopThreadSession({ commandId: CommandId.make(requestId), threadId }),
            );
          const interrupt = () =>
            registry.run(
              environmentId,
              interruptThreadTurn({
                commandId: CommandId.make(input.requestId),
                threadId,
                ...(thread.session?.activeTurnId === null ||
                thread.session?.activeTurnId === undefined
                  ? {}
                  : { turnId: thread.session.activeTurnId }),
              }),
            );
          const restart = () => {
            const previous = thread.messages.findLast((message) => message.role === "user");
            if (previous === undefined) {
              return Effect.fail(
                new GatewayThreadRetryError({
                  message: `Thread ${input.threadId} has no user message to retry.`,
                }),
              );
            }
            return registry.run(
              environmentId,
              startThreadTurn({
                commandId: CommandId.make(input.requestId),
                threadId,
                message: {
                  messageId: MessageId.make(input.messageId),
                  role: "user",
                  text: previous.text,
                  attachments: [],
                },
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              }),
            );
          };

          if (input.action === "stop") yield* stop();
          else if (input.action === "cancel" || input.action === "pause") yield* interrupt();
          else {
            if (input.action === "restart") yield* stop(`${input.requestId}-stop`);
            yield* restart();
          }

          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    respondToApproval: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            respondToThreadApproval({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              requestId: ApprovalRequestId.make(input.approvalRequestId),
              decision: input.decision,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
  };
}
