import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
});
