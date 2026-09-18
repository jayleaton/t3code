import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { handlers } from "./handlers.ts";
import { WorkspaceMcpAuth } from "./principal.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";

for (const prompt of [undefined, "Report ready without changing files"]) {
  it.effect(
    prompt
      ? "creates the thread before dispatching its first turn"
      : "creates an empty named thread without starting a turn",
    () =>
      Effect.gen(function* () {
        const threads = new Map<string, string>();
        const turns: string[] = [];
        const createdAt = "2026-09-18T00:00:00.000Z";
        const projectId = ProjectId.make("project");
        const result = yield* handlers
          .start_thread({ projectId, title: "Voice verification", ...(prompt ? { prompt } : {}) })
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkspaceMcpAuth, { kind: "loopback" }),
                Layer.mock(ProjectionSnapshotQuery)({
                  getProjectShellById: () =>
                    Effect.succeed(
                      Option.some({
                        id: projectId,
                        title: "Project",
                        workspaceRoot: "/workspace",
                        defaultModelSelection: null,
                        scripts: [],
                        createdAt,
                        updatedAt: createdAt,
                      }),
                    ),
                }),
                Layer.mock(ProviderRegistry)({
                  getProviders: Effect.succeed([
                    {
                      instanceId: ProviderInstanceId.make("codex"),
                      driver: ProviderDriverKind.make("codex"),
                      enabled: true,
                      installed: true,
                      version: "1",
                      status: "ready",
                      auth: { status: "authenticated" },
                      checkedAt: createdAt,
                      models: [
                        {
                          slug: "test",
                          name: "Test",
                          isDefault: true,
                          isCustom: false,
                          capabilities: null,
                        },
                      ],
                      slashCommands: [],
                      skills: [],
                    },
                  ]),
                }),
                Layer.mock(OrchestrationEngineService)({
                  dispatch: (command: OrchestrationCommand) =>
                    Effect.sync(() => {
                      if (command.type === "thread.create")
                        threads.set(command.threadId, command.title);
                      if (command.type === "thread.turn.start") {
                        if (!threads.has(command.threadId))
                          throw new Error("Cannot start work before the thread exists");
                        turns.push(command.message.text);
                      }
                      return { sequence: threads.size + turns.length };
                    }),
                }),
                NodeServices.layer,
              ),
            ),
          );
        expect(threads.get(result.threadId)).toBe("Voice verification");
        expect(turns).toEqual(prompt ? [prompt] : []);
      }),
  );
}
