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
  respondToThreadApprovals,
  startThreadTurn,
  stopThreadSession,
} from "../operations/commands.ts";
import { request, runStream, subscribe } from "../rpc/client.ts";
import type {
  GatewayProfileModelSelection,
  GatewayRuntimeEvent,
  GatewayRuntimeEventSource,
  GatewayRuntimePort,
} from "./port.ts";

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
      subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId, turnLimit: 100 }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.runHead,
        Effect.map(
          (item) =>
            (Option.getOrThrow(item) as { snapshot: OrchestrationThreadDetailSnapshot }).snapshot,
        ),
      ),
    );
  });

export function gatewayEventFromOrchestration(
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
  const activityPayload =
    typeof activity?.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
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
      ...(activityKind === undefined ? {} : { activityKind }),
      ...(typeof activityPayload?.requestId === "string"
        ? { requestId: activityPayload.requestId.slice(0, 256) }
        : {}),
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
    listProfiles: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const settings = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.serverGetSettings, {}),
          );
          return settings.mcpGatewayProfiles.map((profile) => ({
            ...profile,
            modelSelection: profile.modelSelection as GatewayProfileModelSelection | undefined,
          }));
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
              ...(input.profileSnapshot === undefined
                ? {}
                : { profileSnapshot: input.profileSnapshot }),
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
    respondToApprovals: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            respondToThreadApprovals({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              responses: input.responses.map((response) => ({
                requestId: ApprovalRequestId.make(response.approvalRequestId),
                decision: response.decision,
              })),
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
    executeOperation: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(input.environmentId);
          const payload = input.payload;
          const projectId =
            typeof payload.projectId === "string" ? ProjectId.make(payload.projectId) : undefined;
          const project =
            projectId === undefined
              ? undefined
              : (yield* shellSnapshot(environmentId)).projects.find(
                  (candidate) => candidate.id === projectId,
                );
          const cwd = project?.workspaceRoot;
          if (input.operation === "git.status") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            return (yield* registry.run(
              environmentId,
              subscribe(WS_METHODS.subscribeVcsStatus, { cwd }).pipe(
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              ),
            )) as unknown as Record<string, unknown>;
          }
          if (input.operation === "git.diff") {
            const rawThreadId = String(payload.threadId ?? "");
            const detail = yield* threadSnapshot(environmentId, ThreadId.make(rawThreadId));
            return (yield* registry.run(
              environmentId,
              request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
                threadId: ThreadId.make(rawThreadId),
                toTurnCount: detail.thread.messages.filter((message) => message.role === "user")
                  .length,
              }),
            )) as unknown as Record<string, unknown>;
          }
          const prRef = {
            projectId: ProjectId.make(String(payload.projectId ?? "")),
            repository: String(payload.repository ?? ""),
            number: Number(payload.number),
          };
          if (input.operation === "pr.apply_review_fixes") {
            const activity = yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsActivity, prRef),
            );
            const requestedIds = new Set(
              Array.isArray(payload.commentIds)
                ? payload.commentIds.filter((id): id is string => typeof id === "string")
                : [],
            );
            const selectedThreads = activity.reviewThreads.filter((thread) =>
              requestedIds.has(thread.id),
            );
            if (selectedThreads.length !== requestedIds.size) {
              throw new Error("One or more review comment IDs are no longer available.");
            }
            const threadId = ThreadId.make(String(payload.threadId ?? ""));
            const shell = yield* shellSnapshot(environmentId);
            const thread = shell.threads.find((candidate) => candidate.id === threadId);
            if (thread === undefined) throw new Error(`Thread ${threadId} was not found.`);
            const requestId = input.requestId ?? `gateway-pr-fixes-${String(payload.number)}`;
            const instructions = selectedThreads
              .map(
                (reviewThread) =>
                  `${reviewThread.path}:${String(reviewThread.line ?? "file")}\n${reviewThread.comments
                    .map((comment) => comment.body)
                    .join("\n")}`,
              )
              .join("\n\n");
            yield* registry.run(
              environmentId,
              startThreadTurn({
                commandId: CommandId.make(requestId),
                threadId,
                message: {
                  messageId: MessageId.make(`${requestId}-message`),
                  role: "user",
                  text: `Apply only these approved pull request review fixes. Do not resolve review threads; they remain unresolved until the pull request is refreshed.\n\n${instructions}`,
                  attachments: [],
                },
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              }),
            );
            return { queued: true, threadId, reviewThreadIds: [...requestedIds] };
          }
          if (input.operation === "pr.update") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsUpdate, {
                ...prRef,
                ...(typeof payload.title === "string" ? { title: payload.title } : {}),
                ...(typeof payload.body === "string" ? { body: payload.body } : {}),
              }),
            );
            return { updated: true };
          }
          if (input.operation === "pr.reply") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsReplyToThread, {
                ...prRef,
                threadId: String(payload.commentId ?? ""),
                body: String(payload.body ?? ""),
              }),
            );
            return { replied: true };
          }
          if (input.operation === "pr.publish") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsRunAction, { ...prRef, action: "ready" }),
            );
            return { published: true };
          }
          if (input.operation === "git.apply_patch") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            yield* registry.run(
              environmentId,
              request(WS_METHODS.vcsApplyPatch, {
                cwd,
                patch: String(payload.patch),
              }),
            );
            return { applied: true };
          }
          if (input.operation === "git.create_branch") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            return (yield* registry.run(
              environmentId,
              request(WS_METHODS.vcsCreateRef, {
                cwd,
                refName: String(payload.branch ?? ""),
                switchRef: true,
              }),
            )) as unknown as Record<string, unknown>;
          }
          if (input.operation === "git.commit" || input.operation === "git.create_pr") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            const action = input.operation === "git.commit" ? "commit" : "create_pr";
            if (input.operation === "git.create_pr") {
              const refs = yield* registry.run(
                environmentId,
                request(WS_METHODS.vcsListRefs, {
                  cwd,
                  refKind: "all",
                  includeMatchingRemoteRefs: true,
                  refresh: true,
                  limit: 500,
                }),
              );
              const head = refs.refs.find((ref) => ref.current)?.name;
              const defaultRefs = refs.refs
                .filter((ref) => ref.isDefault)
                .map((ref) => ref.name.split("/").at(-1));
              if (
                head !== payload.headBranch ||
                !defaultRefs.includes(String(payload.baseBranch))
              ) {
                throw new Error(
                  "Pull request head/base must match the selected project's current and default refs.",
                );
              }
            }
            const progress = yield* registry.run(
              environmentId,
              runStream(WS_METHODS.gitRunStackedAction, {
                actionId: input.requestId ?? `gateway-${input.operation}`,
                cwd,
                action,
                ...(input.operation === "git.create_pr" && typeof payload.draft === "boolean"
                  ? { draft: payload.draft }
                  : {}),
                ...(typeof payload.message === "string" ? { commitMessage: payload.message } : {}),
                ...(Array.isArray(payload.paths)
                  ? {
                      filePaths: payload.paths.filter(
                        (path): path is string => typeof path === "string",
                      ),
                    }
                  : {}),
              }).pipe(Stream.runLast, Effect.map(Option.getOrThrow)),
            );
            const result =
              typeof progress === "object" &&
              progress !== null &&
              "kind" in progress &&
              progress.kind === "action_finished"
                ? progress.result
                : undefined;
            if (
              input.operation === "git.create_pr" &&
              result?.pr.number !== undefined &&
              typeof payload.owner === "string" &&
              typeof payload.repository === "string" &&
              typeof payload.title === "string"
            ) {
              yield* registry.run(
                environmentId,
                request(WS_METHODS.pullRequestsUpdate, {
                  projectId: ProjectId.make(String(payload.projectId)),
                  repository: payload.repository,
                  number: result.pr.number,
                  title: payload.title,
                  ...(typeof payload.body === "string" ? { body: payload.body } : {}),
                }),
              );
            }
            return (result ?? progress) as unknown as Record<string, unknown>;
          }
          throw new Error(`Gateway operation ${input.operation} is not supported by this runtime.`);
        }),
      ),
  };
}
