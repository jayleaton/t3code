import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
} from "./projectThreadStartTurn";

const decodeTurnStart = Schema.decodeUnknownSync(ThreadTurnStartCommand);

describe("project thread title", () => {
  it("keeps ordinary titles and the empty-prompt fallback", () => {
    expect(deriveThreadTitleFromPrompt("  Fix\n the parser  ")).toBe("Fix the parser");
    expect(deriveThreadTitleFromPrompt(" \n ")).toBe("New thread");
  });

  it.each([
    {
      comment: undefined,
      title: "Keep `cache[key]` & <parser> shared. Retry!",
    },
    {
      comment: 'Why "shared"?',
      title: 'Keep `cache[key]` & <parser> shared. Retry! Comment: Why "shared"?',
    },
  ])("uses readable titles and intact links with comment $comment", ({ comment, title }) => {
    const quoteText = "Keep `cache[key]` & <parser> shared.\n  Retry!";
    const text = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: quoteText,
      ...(comment === undefined ? {} : { comment }),
      start: 0,
      end: quoteText.length,
      prefix: "",
      suffix: "",
    });
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "new-thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-09-01T00:00:00Z",
      text,
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.text).toBe(text);
  });
});

describe("new thread on an existing branch", () => {
  it.each([null, "/worktrees/existing"])(
    "reuses the selected workspace %s without preparing a new worktree",
    (worktreePath) => {
      const input = buildProjectThreadStartTurnInput({
        projectId: ProjectId.make("project"),
        projectCwd: "/workspace",
        threadId: "new-thread",
        commandId: "command",
        messageId: "message",
        createdAt: "2026-09-06T00:00:00Z",
        text: "Start fresh",
        uploadedAttachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceMode: "local",
        branch: "feature/existing",
        worktreePath,
        startFromOrigin: false,
        worktreeBranchName: "unused",
      });

      expect(input.bootstrap.createThread).toMatchObject({
        projectId: "project",
        branch: "feature/existing",
        worktreePath,
      });
      expect(input.bootstrap).not.toHaveProperty("prepareWorktree");
      expect(input.bootstrap).not.toHaveProperty("runSetupScript");
      expect(input.threadId).toBe("new-thread");
    },
  );
});

describe("agent chat bootstrap", () => {
  it("preserves agent revision and explicit defaults in a valid V2 command", () => {
    const profileSelection = {
      profileId: "reviewer",
      revision: 3,
      overrideFields: ["modelSelection", "runtimeMode", "interactionMode", "reasoningEffort"],
    } as const;
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      profileSelection,
      threadId: "thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-10-04T00:00:00.000Z",
      text: "Review the fix",
      uploadedAttachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceMode: "local",
      branch: "main",
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });
    const command = decodeTurnStart({
      type: "thread.turn.start",
      ...input,
    });
    expect(command.bootstrap?.createThread?.profileSelection).toEqual(profileSelection);
    expect(command.bootstrap?.createThread?.modelSelection).toEqual(input.modelSelection);
    expect(command.runtimeMode).toBe("approval-required");
    expect(command.interactionMode).toBe("plan");
  });
});
