import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  OrchestrationThreadShell,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { agentThreadStatus, groupAgentThreads, isAgentChatInFocus } from "./agents.logic";
const profile: McpGatewayProfile = {
  profileId: "write",
  name: "Write",
  revision: 2,
  providerLabel: "Codex",
  modelLabel: "GPT",
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);
const thread = (id: string, profileId: string | null, settledAt: string | null = null) => ({
  environmentId: EnvironmentId.make("local"),
  ...decodeThread({
    id,
    projectId: "p",
    title: id,
    modelSelection: { instanceId: "codex", model: "old-gpt" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    session: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledAt,
    ...(profileId
      ? {
          profileSnapshot: {
            profileId,
            profileName: "Write",
            revision: 1,
            effectiveSource: {
              modelSelection: "profile",
              runtimeMode: "profile",
              interactionMode: "profile",
              reasoningEffort: "profile",
            },
          },
        }
      : {}),
  }),
});
describe("agent thread grouping", () => {
  it("keeps old revisions grouped, retains removed agents, and recedes settled work", () => {
    const old = thread("old-model", "write");
    const done = thread("done", "write", "2026-09-06T01:00:00.000Z");
    const orphan = thread("orphan", "removed");
    const result = groupAgentThreads([profile], [done, old, orphan, thread("regular", null)]);
    expect(result.groups.get("write")?.map((item) => item.id)).toEqual(["old-model", "done"]);
    expect(result.orphaned).toEqual([orphan]);
    expect(old.modelSelection.model).toBe("old-gpt");
    expect(agentThreadStatus(done)).toBe("done");
    expect(agentThreadStatus(old)).toBe("idle");
    expect(groupAgentThreads([], [old]).orphaned).toEqual([old]);
  });
});

describe("agent chat focus", () => {
  const completed = () => ({
    ...thread("complete", "write"),
    latestTurn: {
      turnId: "turn" as NonNullable<ReturnType<typeof thread>["latestTurn"]>["turnId"],
      state: "completed" as const,
      requestedAt: "2026-09-06T00:00:00.000Z",
      startedAt: "2026-09-06T00:00:00.000Z",
      completedAt: "2026-09-06T00:02:00.000Z",
      assistantMessageId: null,
    },
  });
  it("keeps a never-opened completion until it is viewed, and keeps the selected chat", () => {
    const done = completed();
    expect(agentThreadStatus(done)).toBe("done");
    expect(isAgentChatInFocus(done, undefined, false)).toBe(true);
    expect(isAgentChatInFocus(done, "2026-09-06T00:01:00.000Z", false)).toBe(true);
    expect(isAgentChatInFocus(done, "2026-09-06T00:03:00.000Z", false)).toBe(false);
    expect(isAgentChatInFocus(done, "2026-09-06T00:03:00.000Z", true)).toBe(true);
  });
  it("shows idle and running chats but respects explicit settlement", () => {
    expect(isAgentChatInFocus(thread("idle", "write"), undefined, false)).toBe(true);
    const running = {
      ...completed(),
      latestTurn: { ...completed().latestTurn, state: "running" as const, completedAt: null },
    };
    expect(agentThreadStatus(running)).toBe("running");
    expect(isAgentChatInFocus(running, "2026-09-06T00:03:00.000Z", false)).toBe(true);
    const settled = { ...completed(), settledAt: "2026-09-06T00:03:00.000Z" };
    expect(isAgentChatInFocus(settled, undefined, false)).toBe(false);
    expect(isAgentChatInFocus(settled, undefined, true)).toBe(true);
  });
});
