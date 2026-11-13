import {
  isListedThread,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as PushRegistrations from "./PushRegistrations.ts";
import { decidePush, type PushKind, type PushObservation } from "./pushPolicy.ts";

export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Checks one thread now, as its next event would. */
    readonly notifyThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/push/PushNotifier") {}

/** Overridable so a test or a local fake can stand in for Expo. */
const expoPushUrlConfig = Config.String("T3CODE_EXPO_PUSH_URL").pipe(
  Config.withDefault("https://exp.host"),
  Config.map((url) => url.replace(/\/+$/, "")),
);

// A completed run can be followed at once by its continuation; wait before calling it finished.
const COMPLETION_HOLD_MS = 5_000;
// Expo reports most dead tokens in receipts, which are ready about 15 minutes after a send.
const RECEIPT_DELAY = "15 minutes";
const EXPO_BATCH = 100;

const BODY: Record<PushKind, string> = {
  input: "Needs your input",
  approval: "Needs approval",
  completed: "Finished",
  failed: "Failed",
};

export interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly sound: "default";
  readonly data: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly kind: PushKind;
  };
}

const ExpoError = Schema.Struct({
  details: Schema.optional(Schema.Struct({ error: Schema.optional(Schema.String) })),
});
const ExpoTicket = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), id: Schema.String }),
  Schema.Struct({ status: Schema.Literal("error"), ...ExpoError.fields }),
]);
const ExpoSendResponse = Schema.Struct({ data: Schema.Array(ExpoTicket) });
const ExpoReceipt = Schema.Struct({ status: Schema.String, ...ExpoError.fields });
const ExpoReceiptsResponse = Schema.Struct({
  data: Schema.Record(Schema.String, ExpoReceipt),
});

const isDeviceNotRegistered = (entry: typeof ExpoError.Type) =>
  entry.details?.error === "DeviceNotRegistered";

function shouldProcessEvent(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "thread.created":
    case "thread.settled":
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "subagent.updated":
      return true;
    case "turn-item.updated":
      return turnItemUpdateCanEndBackgroundWork(event.payload);
    default:
      return false;
  }
}

const isTopLevel = (thread: AgentAwarenessThread) =>
  thread.parentThreadId == null &&
  thread.lineage.parentThreadId === null &&
  thread.delegatedFrom == null &&
  isListedThread(thread);

function attentionPhase(thread: AgentAwarenessThread) {
  const request = thread.pendingRuntimeRequest;
  if (request === null || request.kind === "auth_refresh") return null;
  return request.kind === "user_input" ? "waiting_for_input" : "waiting_for_approval";
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const registrations = yield* PushRegistrations.PushRegistrations;
  const http = yield* HttpClient.HttpClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const expoUrl = yield* expoPushUrlConfig;

  const observed = new Map<ThreadId, PushObservation>();
  const completionHolds = new Map<ThreadId, number>();

  const postJson = <S extends Schema.Top>(path: string, body: unknown, schema: S) =>
    HttpClientRequest.post(`${expoUrl}${path}`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe(body),
      http.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.timeout("10 seconds"),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    );

  const readThread = (threadId: ThreadId) =>
    orchestrator
      .getAgentAwarenessSnapshot(threadId)
      .pipe(Effect.map((snapshot) => snapshot.threads[0] ?? null));

  // A child of any kind never pushes itself; its question is sent as its top-level thread's.
  const topLevelAncestor = Effect.fnUntraced(function* (thread: AgentAwarenessThread) {
    const seen = new Set<ThreadId>([thread.id]);
    let current: AgentAwarenessThread | null = thread;
    while (current !== null && !isTopLevel(current)) {
      // A task delegated from another machine has its parent there.
      if (current.delegatedFrom != null) return null;
      const parentId: ThreadId | null =
        current.parentThreadId ?? current.lineage.parentThreadId ?? null;
      if (parentId === null || seen.has(parentId)) return null;
      seen.add(parentId);
      current = yield* readThread(parentId);
    }
    return current;
  });

  const checkReceipts = Effect.fn("PushNotifier.checkReceipts")(function* (
    tokensByTicket: ReadonlyMap<string, string>,
  ) {
    yield* Effect.sleep(RECEIPT_DELAY);
    const response = yield* postJson(
      "/--/api/v2/push/getReceipts",
      { ids: [...tokensByTicket.keys()] },
      ExpoReceiptsResponse,
    );
    const dead = Object.entries(response.data).flatMap(([id, receipt]) => {
      const token = tokensByTicket.get(id);
      return token !== undefined && isDeviceNotRegistered(receipt) ? [token] : [];
    });
    yield* registrations.removeTokens(dead);
  });

  const send = Effect.fn("PushNotifier.send")(function* (
    content: Omit<PushMessage, "to">,
    scope: Scope.Scope,
  ) {
    const targets = yield* registrations.listDeliverable;
    for (let start = 0; start < targets.length; start += EXPO_BATCH) {
      const batch = targets.slice(start, start + EXPO_BATCH);
      const messages: ReadonlyArray<PushMessage> = batch.map((target) => ({
        to: target.expoPushToken,
        ...content,
      }));
      const response = yield* postJson("/--/api/v2/push/send", messages, ExpoSendResponse);
      const dead: Array<string> = [];
      const tokensByTicket = new Map<string, string>();
      response.data.forEach((ticket, index) => {
        const token = batch[index]?.expoPushToken;
        if (token === undefined) return;
        if (ticket.status === "ok") tokensByTicket.set(ticket.id, token);
        else if (isDeviceNotRegistered(ticket)) dead.push(token);
      });
      yield* registrations.removeTokens(dead);
      if (tokensByTicket.size > 0) {
        yield* checkReceipts(tokensByTicket).pipe(
          Effect.catchCause((cause) => Effect.logWarning("push receipt check failed", { cause })),
          Effect.forkIn(scope),
        );
      }
    }
  });

  const makeProcess = (scope: Scope.Scope, enqueue: (threadId: ThreadId) => Effect.Effect<void>) =>
    Effect.fnUntraced(function* (threadId: ThreadId) {
      const thread = yield* readThread(threadId);
      if (thread === null || thread.archivedAt !== null) {
        observed.delete(threadId);
        completionHolds.delete(threadId);
        return;
      }
      const topLevel = isTopLevel(thread);
      const state = topLevel
        ? projectThreadAwarenessV2({ environmentId, project: { title: "" }, thread })
        : null;
      const next: PushObservation = {
        phase: topLevel ? (state?.phase ?? null) : attentionPhase(thread),
        requestId: thread.pendingRuntimeRequest?.id ?? null,
        updatedAtMs: thread.updatedAt.epochMilliseconds,
      };
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const kind = decidePush({
        previous: observed.get(threadId),
        next,
        facts: {
          topLevel,
          snoozed: thread.snoozedUntil != null && thread.snoozedUntil.epochMilliseconds > nowMs,
        },
        nowMs,
      });
      if (kind === "completed") {
        const deadline = completionHolds.get(threadId);
        if (deadline === undefined) {
          completionHolds.set(threadId, nowMs + COMPLETION_HOLD_MS);
          yield* Effect.sleep(COMPLETION_HOLD_MS).pipe(
            Effect.andThen(enqueue(threadId)),
            Effect.forkIn(scope),
          );
          return;
        }
        if (nowMs < deadline) return;
      }
      completionHolds.delete(threadId);
      observed.set(threadId, next);
      if (kind === null) return;

      const owner = topLevel ? thread : yield* topLevelAncestor(thread);
      if (owner === null) return;
      const project = yield* projects
        .getById(owner.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      yield* send(
        {
          title: owner.title,
          body: Option.match(project, {
            onNone: () => BODY[kind],
            onSome: (value) => `${BODY[kind]} · ${value.title}`,
          }),
          sound: "default",
          data: { environmentId, threadId: owner.id, kind },
        },
        scope,
      );
    });

  const scope = yield* Effect.scope;
  const queued = new Set<ThreadId>();
  const enqueue = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      // Drop the id once processing starts, so a later event queues one more pass.
      queued.add(threadId);
      return worker.enqueue(threadId);
    });
  const process = makeProcess(scope, enqueue);
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(
      Effect.andThen(process(threadId)),
      Effect.catchCause((cause) =>
        Effect.logWarning("push notification failed", { threadId, cause }),
      ),
      Effect.withSpan("PushNotifier.processThread"),
    ),
  );

  const start: PushNotifier["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        shouldProcessEvent(event) ? enqueue(event.threadId) : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("push notifier event stream failed", { cause }),
        ),
      ),
    );

  return PushNotifier.of({
    start,
    notifyThread: Effect.fn("PushNotifier.notifyThread")(function* (threadId: ThreadId) {
      yield* enqueue(threadId);
      yield* worker.drain;
    }),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(PushNotifier, make);
