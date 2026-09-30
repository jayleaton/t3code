import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
let sequence = 0;

const apply = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel });
    let next = readModel;
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence });
    }
    return next;
  });

const createThread = (id: string, parentThreadId?: string): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...(parentThreadId === undefined ? {} : { parentThreadId: ThreadId.make(parentThreadId) }),
  branch: null,
  worktreePath: null,
  createdAt: NOW,
});

const setParent = (id: string, parentThreadId: string | null): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.make(`parent-${id}-${parentThreadId}`),
  threadId: ThreadId.make(id),
  parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
});

const seed = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(NOW), {
    sequence: 0,
    eventId: EventId.make("evt-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: NOW,
    commandId: CommandId.make("cmd-project"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project"),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  const withParent = yield* apply(withProject, createThread("parent"));
  return yield* apply(withParent, createThread("child", "parent"));
});

const parentOf = (readModel: OrchestrationReadModel, id: string) =>
  readModel.threads.find((thread) => thread.id === id)?.parentThreadId ?? null;

it.layer(NodeServices.layer)("thread parent links", (it) => {
  it.effect("records the parent a thread was created under", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      expect(parentOf(readModel, "child")).toBe("parent");
      expect(parentOf(readModel, "parent")).toBeNull();
    }),
  );

  it.effect("rejects a parent that does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const result = yield* Effect.result(apply(readModel, createThread("orphan", "missing")));
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("detaches and re-attaches through thread.meta.update", () =>
    Effect.gen(function* () {
      const detached = yield* apply(yield* seed, setParent("child", null));
      expect(parentOf(detached, "child")).toBeNull();
      const reattached = yield* apply(detached, setParent("child", "parent"));
      expect(parentOf(reattached, "child")).toBe("parent");
    }),
  );

  it.effect("refuses links that would make a thread its own ancestor", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      expect((yield* Effect.result(apply(readModel, setParent("parent", "child"))))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(apply(readModel, setParent("child", "child"))))._tag).toBe(
        "Failure",
      );
    }),
  );

  const settle = (id: string, at: string): OrchestrationCommand => ({
    type: "thread.settle",
    commandId: CommandId.make(`settle-${id}-${at}`),
    threadId: ThreadId.make(id),
  });
  const unsettle = (id: string): OrchestrationCommand => ({
    type: "thread.unsettle",
    commandId: CommandId.make(`unsettle-${id}`),
    threadId: ThreadId.make(id),
    reason: "user",
  });
  const settledAtOf = (readModel: OrchestrationReadModel, id: string) =>
    readModel.threads.find((thread) => thread.id === id)?.settledAt ?? null;
  const running = (readModel: OrchestrationReadModel, id: string): OrchestrationReadModel => ({
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === id
        ? { ...thread, session: { status: "running" } as OrchestrationThread["session"] }
        : thread,
    ),
  });
  // parent > child > grandchild, parent > busy (running), parent > earlier (settled first).
  const tree = Effect.gen(function* () {
    let readModel = yield* seed;
    for (const [id, parent] of [
      ["grandchild", "child"],
      ["busy", "parent"],
      ["earlier", "parent"],
    ] as const) {
      readModel = yield* apply(readModel, createThread(id, parent));
    }
    yield* TestClock.setTime(Date.parse("2026-09-01T00:00:00.000Z"));
    readModel = yield* apply(readModel, settle("earlier", "first"));
    yield* TestClock.setTime(Date.parse("2026-09-02T00:00:00.000Z"));
    return running(readModel, "busy");
  });

  it.effect("settling a chat settles its idle sub-runs at every depth", () =>
    Effect.gen(function* () {
      const readModel = yield* tree;
      const decided = yield* decideOrchestrationCommand({
        command: settle("parent", "second"),
        readModel,
      });
      // The receipt records the last event's aggregate, so the parent's comes last.
      expect(Array.isArray(decided) ? decided.at(-1)?.aggregateId : undefined).toBe("parent");
      const settled = yield* apply(readModel, settle("parent", "second"));
      const at = "2026-09-02T00:00:00.000Z";
      expect(settledAtOf(settled, "parent")).toBe(at);
      expect(settledAtOf(settled, "child")).toBe(at);
      expect(settledAtOf(settled, "grandchild")).toBe(at);
      expect(settledAtOf(settled, "busy")).toBeNull();
      expect(settledAtOf(settled, "earlier")).toBe("2026-09-01T00:00:00.000Z");
    }),
  );

  it.effect("unsettling a chat brings back only the sub-runs settled with it", () =>
    Effect.gen(function* () {
      const settled = yield* apply(yield* tree, settle("parent", "second"));
      const restored = yield* apply(settled, unsettle("parent"));
      expect(settledAtOf(restored, "parent")).toBeNull();
      expect(settledAtOf(restored, "child")).toBeNull();
      expect(settledAtOf(restored, "grandchild")).toBeNull();
      expect(settledAtOf(restored, "earlier")).toBe("2026-09-01T00:00:00.000Z");
    }),
  );

  it.effect("settling a sub-run leaves its parent alone", () =>
    Effect.gen(function* () {
      const settled = yield* apply(yield* tree, settle("child", "second"));
      expect(settledAtOf(settled, "grandchild")).not.toBeNull();
      expect(settledAtOf(settled, "parent")).toBeNull();
    }),
  );
});
