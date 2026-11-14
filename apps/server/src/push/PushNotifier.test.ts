import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PushNotifier from "./PushNotifier.ts";
import * as PushRegistrations from "./PushRegistrations.ts";

const NOW = Date.parse("2026-11-13T09:00:00.000Z");
const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const token = (id: string) => `ExponentPushToken[${id}]`;

const baseThread = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Fix the login bug",
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  modelSelection: { instanceId: ProviderInstanceId.make("replay"), model: "replay" },
  settledOverride: null,
  archivedAt: null,
  status: "idle",
  pendingRuntimeRequest: null,
  updatedAt: DateTime.makeUnsafe(NOW),
};

it.effect("pushes thread id, environment id, kind and title, and drops dead tokens", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const threads = new Map<ThreadId, AgentAwarenessThread>([[threadId, baseThread as never]]);
    const update = (patch: object, id = threadId) => {
      threads.set(id, {
        ...(threads.get(id) ?? baseThread),
        ...patch,
        updatedAt: DateTime.makeUnsafe(NOW),
      } as never);
    };
    const sends = yield* Queue.unbounded<unknown>();
    const removed = yield* Queue.unbounded<ReadonlyArray<string>>();

    const expo = HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null;
        const reply = (json: unknown) =>
          HttpClientResponse.fromWeb(request, Response.json(json, { status: 200 }));
        if (request.url === "https://expo.test/--/api/v2/push/send") {
          Queue.offerUnsafe(sends, body);
          return reply({
            data: (body as ReadonlyArray<{ to: string }>).map(({ to }) =>
              to === token("b")
                ? { status: "error", details: { error: "DeviceNotRegistered" } }
                : { status: "ok", id: `ticket-${to}` },
            ),
          });
        }
        assert.strictEqual(request.url, "https://expo.test/--/api/v2/push/getReceipts");
        return reply({
          data: {
            [`ticket-${token("c")}`]: {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
            [`ticket-${token("a")}`]: { status: "ok" },
          },
        });
      }),
    );

    // The real store, with removals observable as a milestone.
    const registrations = Layer.effect(
      PushRegistrations.PushRegistrations,
      Effect.gen(function* () {
        const store = yield* PushRegistrations.PushRegistrations;
        return PushRegistrations.PushRegistrations.of({
          ...store,
          removeTokens: (tokens) =>
            store
              .removeTokens(tokens)
              .pipe(
                Effect.tap(() => (tokens.length > 0 ? Queue.offer(removed, tokens) : Effect.void)),
              ),
        });
      }),
    ).pipe(
      Layer.provide(PushRegistrations.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );

    const layer = PushNotifier.layer.pipe(
      Layer.provideMerge(registrations),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, expo),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getAgentAwarenessSnapshot: (id) =>
              Effect.sync(() => {
                const thread = id === undefined ? undefined : threads.get(id);
                return { snapshotSequence: 0, threads: thread === undefined ? [] : [thread] };
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ title: "t3code" } as never),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { T3CODE_EXPO_PUSH_URL: "https://expo.test/" } }),
          ),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('phone', 'phone', '[]', 'bearer-session-token', '2026-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z')
      `;
      const store = yield* PushRegistrations.PushRegistrations;
      for (const id of ["a", "b", "c"]) {
        yield* store.register(AuthSessionId.make("phone"), {
          installId: `install-${id}`,
          expoPushToken: token(id),
        });
      }
      const notifier = yield* PushNotifier.PushNotifier;
      const step = notifier.notifyThread(threadId);

      yield* step;
      update({ status: "running" });
      yield* step;
      update({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(NOW),
        },
      });
      yield* step;

      const message = (to: string, kind: string, body: string) => ({
        to: token(to),
        title: "Fix the login bug",
        body,
        sound: "default",
        data: { environmentId, threadId, kind },
      });
      assert.deepStrictEqual(yield* Queue.take(sends), [
        message("a", "input", "Needs your input · t3code"),
        message("b", "input", "Needs your input · t3code"),
        message("c", "input", "Needs your input · t3code"),
      ]);
      assert.deepStrictEqual(yield* Queue.take(removed), [token("b")]);

      // A finish waits out the hold, so a continuation that starts at once stays quiet.
      update({ pendingRuntimeRequest: null, status: "completed" });
      yield* step;
      assert.strictEqual(yield* Queue.size(sends), 0);
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(yield* Queue.take(sends), [
        message("a", "completed", "Finished · t3code"),
        message("c", "completed", "Finished · t3code"),
      ]);

      // A subagent asks through the chat that owns it.
      const subagentId = ThreadId.make("subagent-1");
      update(
        {
          id: subagentId,
          title: "Explore the codebase",
          status: "running",
          lineage: {
            rootThreadId: threadId,
            parentThreadId: threadId,
            relationshipToParent: "subagent",
          },
        },
        subagentId,
      );
      yield* notifier.notifyThread(subagentId);
      update(
        {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-2"),
            kind: "permission",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        },
        subagentId,
      );
      yield* notifier.notifyThread(subagentId);
      assert.deepStrictEqual(yield* Queue.take(sends), [
        message("a", "approval", "Needs approval · t3code"),
        message("c", "approval", "Needs approval · t3code"),
      ]);

      // A child chat's question goes out as its parent's; its finish stays quiet.
      const childId = ThreadId.make("child-1");
      update(
        {
          id: childId,
          title: "Write the migration",
          status: "running",
          parentThreadId: threadId,
          lineage: { rootThreadId: childId, parentThreadId: null, relationshipToParent: null },
        },
        childId,
      );
      yield* notifier.notifyThread(childId);
      update(
        {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-3"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(NOW),
          },
        },
        childId,
      );
      yield* notifier.notifyThread(childId);
      assert.deepStrictEqual(yield* Queue.take(sends), [
        message("a", "input", "Needs your input · t3code"),
        message("c", "input", "Needs your input · t3code"),
      ]);
      update({ pendingRuntimeRequest: null, status: "completed" }, childId);
      yield* notifier.notifyThread(childId);
      assert.strictEqual(yield* Queue.size(sends), 0);

      yield* TestClock.adjust("15 minutes");
      assert.deepStrictEqual(yield* Queue.take(removed), [token("c")]);
      assert.deepStrictEqual(
        (yield* store.listDeliverable).map((target) => target.expoPushToken),
        [token("a")],
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);
