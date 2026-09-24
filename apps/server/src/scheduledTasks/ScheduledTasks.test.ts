import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type McpGatewayProfile,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { nextRunAt, scheduleProblem } from "./schedule.ts";
import * as ScheduledTasks from "./ScheduledTasks.ts";

const projectId = ProjectId.make("project-1");
const ms = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const profile = (profileId: string): McpGatewayProfile => ({
  profileId,
  name: `Agent ${profileId}`,
  revision: 1,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.gen(function* () {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const settings = yield* Ref.make<ServerSettings>({
    ...DEFAULT_SERVER_SETTINGS,
    mcpGatewayProfiles: [profile("deployer"), profile("reviewer")],
  });
  const layer = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: (id) =>
            Effect.succeed(id === projectId ? Option.some({ id } as never) : Option.none()),
          // A thread exists once a thread.create for it has been dispatched.
          getThreadShellById: (threadId) =>
            Ref.get(dispatched).pipe(
              Effect.map((all) =>
                all.some(
                  (command) => command.type === "thread.create" && command.threadId === threadId,
                )
                  ? Option.some({
                      id: threadId,
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      archivedAt: null,
                    } as unknown as OrchestrationThreadShell)
                  : Option.none(),
              ),
            ),
        }),
        Layer.mock(ServerSettingsService)({ getSettings: Ref.get(settings) }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.fresh(SqlitePersistenceMemory),
      ),
    ),
  );
  const service = Context.get(yield* Layer.build(layer), ScheduledTasks.ScheduledTasks);
  const commands = (type: OrchestrationCommand["type"]) =>
    Ref.get(dispatched).pipe(Effect.map((all) => all.filter((command) => command.type === type)));
  return { service, settings, commands };
});

it.layer(NodeServices.layer)("ScheduledTasks", (it) => {
  it.effect("runs a one-time task once, in a thread created from the agent", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ms("2026-09-24T06:00:00.000Z"));
      const { service, commands } = yield* makeHarness;
      const created = yield* service.create({
        prompt: "Deploy the release\nthen report back",
        profileId: "deployer",
        projectId,
        schedule: { kind: "once", runAt: "2026-09-24T08:00:00Z" },
      });
      assert.equal(created.title, "Deploy the release");
      assert.equal(created.nextRunAt, "2026-09-24T08:00:00.000Z");

      yield* service.runDue;
      assert.lengthOf(yield* commands("thread.turn.start"), 0);

      yield* TestClock.setTime(ms("2026-09-24T08:00:30.000Z"));
      yield* service.runDue;
      yield* service.runDue;

      const [create] = yield* commands("thread.create");
      const turns = yield* commands("thread.turn.start");
      assert.lengthOf(turns, 1);
      assert.equal(
        create?.type === "thread.create" && create.profileSelection?.profileId,
        "deployer",
      );
      const [task] = yield* service.list;
      assert.equal(task?.enabled, false);
      assert.equal(task?.nextRunAt, null);
      assert.equal(task?.runCount, 1);
      assert.equal(task?.lastRunStatus, "sent");
      assert.equal(task?.threadId, create?.type === "thread.create" ? create.threadId : "");
    }),
  );

  it.effect("keeps a recurring task in one thread and collapses missed runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ms("2026-09-24T06:00:00.000Z"));
      const { service, commands } = yield* makeHarness;
      yield* service.create({
        title: "Pull latest",
        prompt: "git pull",
        profileId: "deployer",
        projectId,
        schedule: { kind: "cron", expression: "0 7 * * *", timezone: "UTC" },
      });

      yield* TestClock.setTime(ms("2026-09-24T07:00:05.000Z"));
      yield* service.runDue;
      // The server was down for three mornings; they collapse into one run.
      yield* TestClock.setTime(ms("2026-09-27T09:00:00.000Z"));
      yield* service.runDue;

      assert.lengthOf(yield* commands("thread.create"), 1);
      const turns = yield* commands("thread.turn.start");
      assert.lengthOf(turns, 2);
      assert.equal(
        turns[0]?.type === "thread.turn.start" && turns[1]?.type === "thread.turn.start"
          ? turns[0].threadId === turns[1].threadId
          : false,
        true,
      );
      const [task] = yield* service.list;
      assert.equal(task?.nextRunAt, "2026-09-28T07:00:00.000Z");
      assert.equal(task?.runCount, 2);
    }),
  );

  it.effect("starts a new thread when the agent changes and records failed runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ms("2026-09-24T06:00:00.000Z"));
      const { service, settings, commands } = yield* makeHarness;
      const task = yield* service.create({
        prompt: "Review open PRs",
        profileId: "deployer",
        projectId,
        schedule: { kind: "cron", expression: "*/30 * * * *", timezone: "UTC" },
      });
      const ran = yield* service.runNow(task.taskId);
      assert.notEqual(ran.threadId, null);
      assert.equal(ran.nextRunAt, task.nextRunAt);

      const moved = yield* service.update({
        taskId: task.taskId,
        patch: { profileId: "reviewer" },
      });
      assert.equal(moved.threadId, null);

      yield* Ref.update(settings, (current) => ({ ...current, mcpGatewayProfiles: [] }));
      const failed = yield* service.runNow(task.taskId);
      assert.equal(failed.lastRunStatus, "failed");
      assert.include(failed.lastRunError ?? "", "does not exist");
      assert.lengthOf(yield* commands("thread.create"), 1);
    }),
  );

  it.effect("refuses schedules that cannot run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(ms("2026-09-24T06:00:00.000Z"));
      const { service } = yield* makeHarness;
      const base = { prompt: "x", profileId: "deployer", projectId } as const;
      const past = yield* Effect.flip(
        service.create({ ...base, schedule: { kind: "once", runAt: "2026-09-23T06:00:00Z" } }),
      );
      assert.include(past.message, "in the past");
      const seconds = yield* Effect.flip(
        service.create({
          ...base,
          schedule: { kind: "cron", expression: "0 0 7 * * *", timezone: "UTC" },
        }),
      );
      assert.include(seconds.message, "five fields");
      const agent = yield* Effect.flip(
        service.create({
          ...base,
          profileId: "missing",
          schedule: { kind: "once", runAt: "2026-09-25T06:00:00Z" },
        }),
      );
      assert.include(agent.message, "does not exist");

      // A finished one-time task can only be re-armed with a future time.
      const once = yield* service.create({
        ...base,
        schedule: { kind: "once", runAt: "2026-09-24T06:30:00Z" },
      });
      yield* TestClock.setTime(ms("2026-09-24T07:00:00.000Z"));
      yield* service.runDue;
      const rearm = yield* Effect.flip(
        service.update({ taskId: once.taskId, patch: { enabled: true } }),
      );
      assert.include(rearm.message, "in the past");
      const rescheduled = yield* service.update({
        taskId: once.taskId,
        patch: { schedule: { kind: "once", runAt: "2026-09-25T07:00:00Z" }, enabled: true },
      });
      assert.equal(rescheduled.nextRunAt, "2026-09-25T07:00:00.000Z");
    }),
  );
});

it("evaluates cron in the task's time zone", () => {
  const schedule = { kind: "cron", expression: "0 7 * * 1-5", timezone: "Asia/Bangkok" } as const;
  assert.equal(scheduleProblem(schedule), null);
  // Friday 2026-09-25 07:00 in Bangkok is 00:00 UTC; the next weekday run after it is Monday.
  assert.equal(nextRunAt(schedule, ms("2026-09-24T23:00:00Z")), "2026-09-25T00:00:00.000Z");
  assert.equal(nextRunAt(schedule, ms("2026-09-25T00:00:00Z")), "2026-09-28T00:00:00.000Z");
  assert.isNotNull(scheduleProblem({ ...schedule, timezone: "Mars/Olympus" }));
});
