import { ProjectId, ProviderInstanceId, ThreadProfileSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { serializeComposerMessageForServer } from "./composerContext";

import {
  buildProjectThreadStartTurnInput,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

const decodeProfileSelection = Schema.decodeUnknownSync(ThreadProfileSelection);

describe("project thread title", () => {
  it.each([
    {
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      text: "![photo.png](t3-context://v1/image/photo)",
      title: "Attached image",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "",
      title: "File: report.pdf",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "[report.pdf](t3-context://v1/file/report)",
      title: "report.pdf",
    },
  ])("titles a $type-only message without changing its data", ({ text, title, ...attachment }) => {
    const uploadedAttachments = [{ ...attachment, id: "prepared-attachment", sizeBytes: 3 }];
    const wire = serializeComposerMessageForServer(text, undefined);
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "image-thread",
      commandId: "image-command",
      messageId: "image-message",
      createdAt: "2026-09-04T00:00:00Z",
      ...wire,
      titleText: text,
      uploadedAttachments,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    } satisfies ProjectThreadStartTurnSpec;
    const input = buildProjectThreadStartTurnInput(spec);

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.attachments).toEqual(uploadedAttachments);
    expect(input.message.text).toBe(wire.text);
    const relaunched = buildProjectThreadStartTurnInput({
      ...spec,
      threadId: "local-relaunch",
      text: input.message.text,
      titleText: input.bootstrap.createThread.title,
    });
    expect(relaunched.titleSeed).toBe(title);
    expect(relaunched.message.text).toBe(wire.text);
    expect(relaunched.message.attachments).toEqual(uploadedAttachments);
  });
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
    const command = input;
    expect(decodeProfileSelection(command.bootstrap.createThread.profileSelection)).toEqual(
      profileSelection,
    );
    expect(command.bootstrap?.createThread?.profileSelection).toEqual(profileSelection);
    expect(command.bootstrap?.createThread?.modelSelection).toEqual(input.modelSelection);
    expect(command.runtimeMode).toBe("approval-required");
    expect(command.interactionMode).toBe("plan");
  });
});
