import { describe, expect, it } from "@effect/vitest";

import { createGatewayEventStore } from "./events.ts";
import {
  GatewayError,
  type GatewayProfile,
  type GatewayRuntimePort,
  type GatewayThreadControlAction,
} from "./port.ts";
import { callGatewayTool } from "./tools.ts";

function makePort(input?: {
  readonly controls?: Array<{ action: GatewayThreadControlAction; requestId: string }>;
  readonly approvals?: Array<{ requestId: string; decision: string }>;
  readonly approvalBatches?: Array<ReadonlyArray<{ approvalRequestId: string; decision: string }>>;
  readonly operations?: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }>;
  readonly creates?: Array<{
    instanceId?: string;
    model: string;
    runtimeMode?: string;
    reasoningEffort?: string;
    profileId?: string;
  }>;
  readonly profiles?: ReadonlyArray<GatewayProfile>;
  readonly pendingApprovalPlan?: boolean;
  readonly staleApprovalPlan?: boolean;
  readonly projectOwner?: string;
}): GatewayRuntimePort {
  const environments = ["local", "remote"] as const;
  const threads = new Map<string, Array<Record<string, unknown>>>(
    environments.map((environmentId) => [environmentId, []]),
  );
  return {
    listEnvironments: async () =>
      environments.map((environmentId) => ({
        environmentId,
        label: environmentId,
        targetKind: environmentId === "local" ? "primary" : "relay",
        connectionState: "connected",
      })),
    getEnvironmentStatus: async (environmentId) => ({
      environmentId,
      connectionState: "connected",
    }),
    ...(input?.profiles === undefined
      ? {}
      : { listProfiles: async () => input.profiles as ReadonlyArray<GatewayProfile> }),
    resolveProfileModelSelection: async (_environmentId, profile) =>
      profile.providerLabel === "Codex" && profile.modelLabel === "GPT-5.6 Sol"
        ? { instanceId: "codex", model: "gpt-5.6-sol" }
        : profile.modelSelection,
    listProjects: async (environmentId) => ({
      snapshotAt: "2026-09-02T00:00:00.000Z",
      items: [
        {
          id: `${environmentId}-project`,
          title: "Project",
          workspaceRoot: "/repo",
          repositoryIdentity: { owner: input?.projectOwner ?? "jayleaton", name: "t3code" },
        },
      ],
    }),
    listThreads: async (environmentId) => ({
      snapshotAt: "2026-09-02T00:00:00.000Z",
      items: threads.get(environmentId) ?? [],
    }),
    getThread: async (environmentId, threadId) => ({
      id: threadId,
      environmentId,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          text: `hello from ${environmentId}`,
          attachments: [{ id: "asset-1", kind: "image", name: "result.png" }],
        },
      ],
      activities: input?.pendingApprovalPlan
        ? [
            {
              id: "approval-1",
              sequence: 9,
              kind: "approval.requested",
              payload: { requestId: "approval-1", requestKind: "command", detail: "Run command" },
            },
            {
              id: "approval-2",
              sequence: 10,
              kind: "approval.requested",
              payload: { requestId: "approval-2", requestKind: "file-read", detail: "Read file" },
            },
            ...(input.staleApprovalPlan
              ? [
                  {
                    id: "approval-stale",
                    sequence: 11,
                    kind: "provider.approval.respond.failed",
                    payload: {
                      requestId: "approval-1",
                      detail: "Unknown pending approval request approval-1",
                    },
                  },
                ]
              : []),
          ]
        : [
            { id: "event-1", sequence: 7, kind: "tool", summary: "Ran checks" },
            { id: "event-2", sequence: 8, kind: "info", summary: "Completed" },
          ],
      checkpoints: [{ turnId: "turn-1", files: [{ path: "src/index.ts", kind: "modified" }] }],
      artifacts: [
        {
          artifactId: "asset-1",
          kind: "attachment",
          sourceId: "message-1",
          name: "result.png",
          availability: "available",
        },
        {
          artifactId: "workspace-turn-1-0",
          kind: "workspace-file",
          sourceId: "turn-1",
          path: "src/index.ts",
          changeKind: "modified",
          availability: "available",
        },
      ],
    }),
    createAssetUrl: async () => ({
      relativeUrl: "/asset",
      expiresAt: 1_800_000_000_000,
    }),
    getPullRequest: async () => ({}),
    getPullRequestActivity: async () => ({}),
    createThread: async (request) => {
      input?.creates?.push({
        ...(request.modelSelection?.instanceId === undefined
          ? {}
          : { instanceId: request.modelSelection.instanceId }),
        model: request.modelSelection?.model ?? "server-default",
        ...(request.profileSelection === undefined
          ? {}
          : { profileId: request.profileSelection.profileId }),
        ...(request.runtimeMode === undefined ? {} : { runtimeMode: request.runtimeMode }),
        ...(request.modelSelection?.options?.find((option) => option.id === "reasoningEffort")
          ?.value === undefined
          ? {}
          : {
              reasoningEffort: String(
                request.modelSelection?.options?.find((option) => option.id === "reasoningEffort")
                  ?.value,
              ),
            }),
      });
      const thread = { id: request.threadId, projectId: request.projectId, title: request.title };
      threads.get(request.environmentId)?.push(thread);
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    sendMessage: async (request) => ({
      requestId: request.requestId,
      commandId: request.requestId,
      status: "accepted",
      threadId: request.threadId,
      messageId: request.messageId,
    }),
    controlThread: async (request) => {
      input?.controls?.push({ action: request.action, requestId: request.requestId });
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    respondToApprovals: async (request) => {
      input?.approvalBatches?.push(
        request.responses.map((response) => ({
          approvalRequestId: response.approvalRequestId,
          decision: response.decision,
        })),
      );
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    respondToApproval: async (request) => {
      input?.approvals?.push({ requestId: request.approvalRequestId, decision: request.decision });
      return {
        requestId: request.requestId,
        commandId: request.requestId,
        status: "accepted",
        threadId: request.threadId,
      };
    },
    executeOperation: async (request) => {
      input?.operations?.push({ operation: request.operation, payload: request.payload });
      return { operation: request.operation, accepted: true };
    },
  };
}

const grants = {
  local: [
    "read",
    "create",
    "send",
    "lifecycle",
    "approval",
    "artifact",
    "review",
    "admin",
    "delivery",
  ],
  remote: [
    "read",
    "create",
    "send",
    "lifecycle",
    "approval",
    "artifact",
    "review",
    "admin",
    "delivery",
  ],
} as const;

describe("gateway chat tools", () => {
  it.each(["local", "remote"])("reads, creates, and sends chats in %s", async (environmentId) => {
    const port = makePort();
    const context = { port, grants };

    const listed = await callGatewayTool(context, "t3_list_threads", { environmentId });
    expect(listed).toMatchObject({ items: [] });

    const created = await callGatewayTool(context, "t3_create_thread", {
      environmentId,
      projectId: `${environmentId}-project`,
      title: "Gateway chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: `${environmentId}-create-1`,
    });
    expect(created).toMatchObject({ status: "accepted" });

    const sent = await callGatewayTool(context, "t3_send_message", {
      environmentId,
      threadId: created.threadId,
      text: "Run the checks",
      idempotencyKey: `${environmentId}-send-1`,
    });
    expect(sent).toMatchObject({ status: "accepted", threadId: created.threadId });

    const read = await callGatewayTool(context, "t3_get_messages", {
      environmentId,
      threadId: created.threadId,
    });
    expect(read.items[0]).toMatchObject({ text: `hello from ${environmentId}` });
  });

  it("rejects a mutation when the host has only read scope", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants: { local: ["read"] } }, "t3_send_message", {
        environmentId: "local",
        threadId: "thread-1",
        text: "no",
        idempotencyKey: "send-1",
      }),
    ).rejects.toMatchObject({ code: "scope_required", environmentId: "local" });
  });

  it("queries replayable progress history and artifact metadata", async () => {
    const context = { port: makePort(), grants };
    const history = await callGatewayTool(context, "t3_get_thread_history", {
      environmentId: "local",
      threadId: "thread-1",
      afterSequence: 7,
    });
    const artifacts = await callGatewayTool(context, "t3_list_artifacts", {
      environmentId: "local",
      threadId: "thread-1",
    });
    const image = await callGatewayTool(context, "t3_get_artifact", {
      environmentId: "local",
      threadId: "thread-1",
      artifactId: "asset-1",
      kind: "image",
    });

    expect(history).toEqual({
      items: [{ id: "event-2", sequence: 8, kind: "info", summary: "Completed" }],
      nextCursor: "8",
    });
    expect(artifacts.items).toEqual([
      {
        artifactId: "asset-1",
        kind: "attachment",
        sourceId: "message-1",
        name: "result.png",
        availability: "available",
      },
      {
        artifactId: "workspace-turn-1-0",
        kind: "workspace-file",
        sourceId: "turn-1",
        path: "src/index.ts",
        availability: "available",
      },
    ]);
    expect(image).toMatchObject({
      artifactId: "asset-1",
      availability: "available",
      download: { relativeUrl: "/asset" },
    });
  });

  it("defers named profile defaults to the server while preserving explicit overrides", async () => {
    const creates: Array<{ model: string; runtimeMode?: string; reasoningEffort?: string }> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile-andy",
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 2,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T01:00:00.000Z",
      },
    ];
    const browserLocalProfiles: ReadonlyArray<GatewayProfile> = [
      {
        name: "Andy",
        modelSelection: { instanceId: "codex", model: "stale-local-model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    ];
    const context = {
      port: makePort({ creates, profiles }),
      grants,
      profiles: browserLocalProfiles,
    };

    await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Profiled chat",
      profile: "Andy",
      idempotencyKey: "profile-create-1",
    });
    await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Overridden chat",
      profile: "Andy",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      idempotencyKey: "profile-create-2",
    });

    expect(creates).toEqual([
      {
        instanceId: "glm",
        model: "glm-5.3",
        runtimeMode: "full-access",
        reasoningEffort: "medium",
        profileId: "profile-andy",
      },
      {
        instanceId: "codex",
        model: "gpt-5",
        runtimeMode: "approval-required",
        reasoningEffort: "medium",
        profileId: "profile-andy",
      },
    ]);
  });

  it.each(["cancel", "stop", "pause", "resume", "retry", "restart"] as const)(
    "forwards idempotent %s lifecycle control",
    async (action) => {
      const controls: Array<{ action: GatewayThreadControlAction; requestId: string }> = [];
      const result = await callGatewayTool(
        { port: makePort({ controls }), grants },
        "t3_control_thread",
        {
          environmentId: "local",
          threadId: "thread-1",
          action,
          idempotencyKey: `${action}-1`,
        },
      );

      expect(result).toMatchObject({ status: "accepted", threadId: "thread-1" });
      expect(controls).toEqual([{ action, requestId: `mcp-request-${action}-1` }]);
    },
  );

  it("responds to an approval with a separate control scope", async () => {
    const approvals: Array<{ requestId: string; decision: string }> = [];
    await callGatewayTool(
      {
        port: makePort({ approvals }),
        grants: { local: ["read", "approval"] },
      },
      "t3_respond_to_approval",
      {
        environmentId: "local",
        threadId: "thread-1",
        approvalRequestId: "approval-1",
        decision: "accept",
        idempotencyKey: "approval-decision-1",
      },
    );

    expect(approvals).toEqual([{ requestId: "approval-1", decision: "accept" }]);
  });

  it("rejects unknown environments before invoking the runtime", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants }, "t3_list_threads", {
        environmentId: "missing",
      }),
    ).rejects.toEqual(
      new GatewayError({
        code: "unknown_environment",
        message: "Environment missing is not granted to this host.",
        retryable: false,
        environmentId: "missing",
      }),
    );
  });
});

describe("gateway v3 event delivery tools", () => {
  it("replays an identical create request instead of running it twice", async () => {
    const creates: Array<{ model: string; runtimeMode?: string; reasoningEffort?: string }> = [];
    const events = createGatewayEventStore();
    const context = { port: makePort({ creates }), grants, events };
    const request = {
      environmentId: "local",
      projectId: "local-project",
      title: "Idempotent chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "create-idem-1",
    };

    const first = await callGatewayTool(context, "t3_create_thread", request);
    const second = await callGatewayTool(context, "t3_create_thread", request);

    expect(creates).toEqual([
      { instanceId: "codex", model: "gpt-5", runtimeMode: "approval-required" },
    ]);
    expect(second).toEqual(first);
  });

  it("replays a resolved label-only profile without re-reading the mutable catalog", async () => {
    const creates: Array<{ model: string; runtimeMode: string }> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile-andy",
        name: "Andy",
        revision: 1,
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ];
    const port = makePort({ creates, profiles });
    let resolutions = 0;
    port.resolveProfileModelSelection = async () => {
      resolutions += 1;
      if (resolutions > 1) throw new Error("catalog unavailable");
      return { instanceId: "codex", model: "gpt-5.6-sol" };
    };
    const context = { port, grants, events: createGatewayEventStore() };
    const request = {
      environmentId: "local",
      projectId: "local-project",
      title: "Idempotent profile chat",
      profile: "Andy",
      idempotencyKey: "create-profile-idem-1",
    };

    const first = await callGatewayTool(context, "t3_create_thread", request);
    const second = await callGatewayTool(context, "t3_create_thread", request);

    expect(second).toEqual(first);
    expect(resolutions).toBe(1);
    expect(creates).toHaveLength(1);
  });

  it("recovers an ambiguous upstream receipt without repeating the server side effect", async () => {
    const events = createGatewayEventStore();
    let effects = 0;
    let committedRequestId: string | undefined;
    const port = makePort();
    port.sendMessage = async (request) => {
      if (committedRequestId === undefined) {
        committedRequestId = request.requestId;
        effects += 1;
        throw new Error("transport closed after commit");
      }
      expect(request.requestId).toBe(committedRequestId);
      return {
        requestId: committedRequestId,
        commandId: committedRequestId,
        status: "accepted",
        threadId: request.threadId,
        messageId: request.messageId,
      };
    };
    const context = { port, grants, events };
    const request = {
      environmentId: "local",
      threadId: "thread-1",
      text: "Run once",
      idempotencyKey: "ambiguous-send-1",
    };

    await expect(callGatewayTool(context, "t3_send_message", request)).rejects.toThrow(
      "transport closed after commit",
    );
    await expect(callGatewayTool(context, "t3_send_message", request)).resolves.toMatchObject({
      status: "accepted",
      commandId: "mcp-request-ambiguous-send-1",
    });
    expect(effects).toBe(1);
  });

  it("reports idempotency_conflict when the same key carries a different payload", async () => {
    const creates: Array<{ model: string; runtimeMode?: string; reasoningEffort?: string }> = [];
    const events = createGatewayEventStore();
    const context = { port: makePort({ creates }), grants, events };
    const base = {
      environmentId: "local",
      projectId: "local-project",
      title: "Conflict chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "create-conflict-1",
    };
    await callGatewayTool(context, "t3_create_thread", base);
    await expect(
      callGatewayTool(context, "t3_create_thread", { ...base, title: "Different chat" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("uses first-class artifact records instead of inferring message payloads", async () => {
    const result = await callGatewayTool(
      {
        port: {
          ...makePort(),
          getThread: async () => ({
            artifacts: [
              {
                artifactId: "attachment-1",
                kind: "attachment",
                sourceId: "message-1",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: 42,
                availability: "available",
              },
            ],
            messages: [
              {
                id: "message-evil",
                attachments: [{ id: "leaked", hostPath: "/home/user/secret" }],
              },
            ],
          }),
        },
        grants: { local: ["artifact"] },
      },
      "t3_list_artifacts",
      { environmentId: "local", threadId: "thread-1" },
    );

    expect(result).toEqual({
      items: [
        {
          artifactId: "attachment-1",
          kind: "attachment",
          sourceId: "message-1",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 42,
          availability: "available",
        },
      ],
    });
  });

  it("forwards an atomic approval-plan modification with a revision guard", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    const request = {
      environmentId: "local",
      threadId: "thread-1",
      planRevision: 10,
      modifications: [{ actionId: "approval-1", fields: { decision: "accept" } }],
      idempotencyKey: "modify-approval-1",
    };
    await expect(
      callGatewayTool(
        {
          port: makePort({ operations, pendingApprovalPlan: true }),
          grants: { local: ["read", "approval"] },
        },
        "t3_modify_actions",
        request,
      ),
    ).rejects.toMatchObject({ code: "destructive_confirmation_required" });
    const result = await callGatewayTool(
      {
        port: makePort({ operations, pendingApprovalPlan: true }),
        grants: { local: ["read", "approval"] },
      },
      "t3_modify_actions",
      { ...request, confirmDestructive: true },
    );

    expect(result).toMatchObject({ accepted: true });
    expect(operations).toEqual([
      {
        operation: "approval.modify",
        payload: {
          threadId: "thread-1",
          planRevision: 10,
          modifications: [{ actionId: "approval-1", fields: { decision: "accept" } }],
        },
      },
    ]);
  });

  it("emits lifecycle events and serves replay with cursors and acks", async () => {
    const events = createGatewayEventStore();
    const context = { port: makePort(), grants, events };

    const created = await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Event chat",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      idempotencyKey: "event-create-1",
    });
    await callGatewayTool(context, "t3_control_thread", {
      environmentId: "local",
      threadId: created.threadId,
      action: "stop",
      idempotencyKey: "event-stop-1",
    });
    expect(events.latestSequence("local")).toBe(0);
    events.ingest({
      environmentId: "local",
      eventId: "server-event-1",
      sequence: 1,
      occurredAt: "2026-09-04T00:00:00.000Z",
      type: "thread.started",
      threadId: created.threadId as string,
    });
    events.ingest({
      environmentId: "local",
      eventId: "server-event-2",
      sequence: 2,
      occurredAt: "2026-09-04T00:00:01.000Z",
      type: "thread.state_changed",
      threadId: created.threadId as string,
    });

    const replay = await callGatewayTool(context, "t3_get_events", {
      environmentId: "local",
      afterSequence: 0,
    });
    expect(replay.items.map((event: { type: string }) => event.type)).toEqual([
      "thread.started",
      "thread.state_changed",
    ]);
    expect(replay.latestSequence).toBe(2);

    const subscription = (await callGatewayTool(context, "t3_subscribe_events", {
      environmentId: "local",
      afterSequence: replay.latestSequence,
    })) as { subscriptionId: string; ackedSequence: number };
    expect(subscription.ackedSequence).toBe(2);

    const acked = await callGatewayTool(context, "t3_ack_events", {
      environmentId: "local",
      subscriptionId: subscription.subscriptionId,
      throughSequence: replay.latestSequence,
    });
    expect(acked).toEqual({ subscriptionId: subscription.subscriptionId, ackedSequence: 2 });
    await expect(
      callGatewayTool(context, "t3_ack_events", {
        environmentId: "local",
        subscriptionId: subscription.subscriptionId,
        throughSequence: 999,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Cursor replay honours afterSequence.
    const tail = await callGatewayTool(context, "t3_get_events", {
      environmentId: "local",
      afterSequence: 1,
    });
    expect(tail.items.map((event: { type: string }) => event.type)).toEqual([
      "thread.state_changed",
    ]);
  });

  it("requires read and delivery scopes for webhook registration", async () => {
    const events = createGatewayEventStore();
    await expect(
      callGatewayTool(
        { port: makePort(), grants: { local: ["delivery"] }, events },
        "t3_register_webhook",
        { environmentId: "local", url: "https://example.com/hook" },
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(events.listWebhooks("local")).toEqual([]);
  });

  it("registers, lists, and deletes webhooks without ever re-serving the secret", async () => {
    const events = createGatewayEventStore();
    const context = { port: makePort(), grants, events };

    const registered = (await callGatewayTool(context, "t3_register_webhook", {
      environmentId: "local",
      url: "https://example.com/hook",
      types: ["thread.completed"],
    })) as { webhookId: string; secret: string; secretReference: string };
    expect(registered.secret).not.toBe("");
    expect(registered.secretReference).toBe(`webhook-secret/${registered.webhookId}`);

    const listed = (await callGatewayTool(context, "t3_list_webhooks", {
      environmentId: "local",
    })) as { items: Array<{ secret: string }> };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.secret).toBe("");

    await expect(
      callGatewayTool(context, "t3_register_webhook", {
        environmentId: "local",
        url: "http://example.com/hook",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const deleted = await callGatewayTool(context, "t3_delete_webhook", {
      environmentId: "local",
      webhookId: registered.webhookId,
    });
    expect(deleted).toEqual({ deleted: true });
    expect(
      (await callGatewayTool(context, "t3_list_webhooks", { environmentId: "local" })) as {
        items: unknown[];
      },
    ).toEqual({ items: [] });
  });

  it("requires an event store for delivery tools", async () => {
    await expect(
      callGatewayTool({ port: makePort(), grants }, "t3_subscribe_events", {
        environmentId: "local",
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("reports degraded bridge health instead of claiming a healthy connection", async () => {
    const health = await callGatewayTool(
      {
        port: makePort(),
        grants,
        health: () => ({ bridge: "degraded", degradedReasons: ["bridge address in use"] }),
      },
      "t3_get_gateway_health",
      {},
    );

    expect(health).toMatchObject({
      health: "degraded",
      mcpTransport: "connected",
      bridge: "degraded",
      degradedReasons: ["bridge address in use"],
    });
  });

  it("applies grouped approvals through one atomic runtime command", async () => {
    const approvalBatches: Array<ReadonlyArray<{ approvalRequestId: string; decision: string }>> =
      [];
    const port = makePort({ approvalBatches, pendingApprovalPlan: true });

    const result = await callGatewayTool({ port, grants }, "t3_approve_actions", {
      environmentId: "local",
      threadId: "thread-1",
      actionIds: ["approval-1", "approval-2"],
      planRevision: 10,
      confirmDestructive: true,
      idempotencyKey: "approve-group-1",
    });

    expect(approvalBatches).toEqual([
      [
        { approvalRequestId: "approval-1", decision: "accept" },
        { approvalRequestId: "approval-2", decision: "accept" },
      ],
    ]);
    expect(result).toMatchObject({ approved: 2, pending: 0 });
  });

  it("removes approvals that the canonical server marked stale", async () => {
    const plan = await callGatewayTool(
      {
        port: makePort({ pendingApprovalPlan: true, staleApprovalPlan: true }),
        grants,
      },
      "t3_get_approval_plan",
      { environmentId: "local", threadId: "thread-1" },
    );

    expect(plan).toMatchObject({ revision: 11 });
    expect((plan as { actions: Array<{ approvalActionId: string }> }).actions).toEqual([
      expect.objectContaining({ approvalActionId: "approval-2" }),
    ]);
  });

  it("does not let the legacy control scope authorize repository writes", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    await expect(
      callGatewayTool(
        { port: makePort({ operations }), grants: { local: ["control"] } },
        "t3_apply_patch",
        {
          environmentId: "local",
          projectId: "local-project",
          patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
          idempotencyKey: "patch-control-only",
        },
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(operations).toEqual([]);
  });

  it("rejects patch paths outside the selected project root", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    await expect(
      callGatewayTool({ port: makePort({ operations }), grants }, "t3_apply_patch", {
        environmentId: "local",
        projectId: "local-project",
        patch: "--- a/README.md\n+++ ../../outside\n@@ -1 +1 @@\n-old\n+new\n",
        idempotencyKey: "patch-escape",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(operations).toEqual([]);
  });

  it("rejects upstream repository writes even when the selected project matches", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    await expect(
      callGatewayTool(
        { port: makePort({ operations, projectOwner: "pingdotgg" }), grants },
        "t3_create_pr",
        {
          environmentId: "local",
          projectId: "local-project",
          owner: "pingdotgg",
          repository: "t3code",
          headBranch: "feature/test",
          baseBranch: "main",
          title: "Unsafe upstream write",
          idempotencyKey: "pr-upstream",
        },
      ),
    ).rejects.toMatchObject({ code: "scope_required" });
    expect(operations).toEqual([]);
  });

  it("rejects pull requests targeting a different repository owner", async () => {
    await expect(
      callGatewayTool({ port: makePort({ projectOwner: "jayleaton" }), grants }, "t3_create_pr", {
        environmentId: "local",
        projectId: "local-project",
        owner: "fork-owner",
        repository: "t3code",
        headBranch: "feature/test",
        baseBranch: "main",
        title: "Test",
        idempotencyKey: "pr-fork",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("routes v3 write tools through the runtime operation boundary idempotently", async () => {
    const operations: Array<{ operation: string; payload: Readonly<Record<string, unknown>> }> = [];
    const events = createGatewayEventStore();
    const context = { port: makePort({ operations }), grants, events };
    const input = {
      environmentId: "local",
      projectId: "local-project",
      repository: "jayleaton/t3code",
      number: 12,
      title: "Updated",
      idempotencyKey: "update-pr-1",
    };

    const first = await callGatewayTool(context, "t3_update_pr", input);
    const second = await callGatewayTool(context, "t3_update_pr", input);

    expect(first).toEqual(second);
    expect(operations).toEqual([{ operation: "pr.update", payload: input }]);
  });
});

describe("gateway v3 profile selection", () => {
  it("carries profile identity, revision, and resolved routing to the authoritative server", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        modelSelection: { instanceId: "glm", model: "glm-5.3" },
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 3,
      },
    ];
    const port = makePort({ profiles });
    const original = port.createThread.bind(port);
    port.createThread = async (request) => {
      creates.push(request as unknown as Record<string, unknown>);
      return original(request);
    };
    const context = { port, grants, profiles };

    await callGatewayTool(context, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Snapshot chat",
      profileId: "profile_andy",
      idempotencyKey: "snapshot-create-1",
    });

    expect(creates[0]).toMatchObject({
      modelSelection: {
        instanceId: "glm",
        model: "glm-5.3",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      profileSelection: {
        profileId: "profile_andy",
        revision: 3,
        overrideFields: [],
      },
    });
    expect(creates[0]).not.toHaveProperty("profileSnapshot");
  });

  it("does not synthesize a caller-owned profile snapshot when no profile applies", async () => {
    const creates: Array<Record<string, unknown>> = [];
    const port = makePort();
    const original = port.createThread.bind(port);
    port.createThread = async (request) => {
      creates.push(request as unknown as Record<string, unknown>);
      return original(request);
    };
    await callGatewayTool({ port, grants }, "t3_create_thread", {
      environmentId: "local",
      projectId: "local-project",
      title: "Fallback chat",
      idempotencyKey: "fallback-create-1",
    });
    expect(creates[0]).not.toHaveProperty("profileSnapshot");
    expect(creates[0]).not.toHaveProperty("profileSelection");
    expect(creates[0]).not.toHaveProperty("modelSelection");
  });
});

describe("gateway v3 readable profiles", () => {
  it("surfaces readable labels on t3_list_profiles without requiring routing keys", async () => {
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
        reasoningEffort: "medium",
        runtimeMode: "full-access",
        interactionMode: "default",
        revision: 1,
      },
    ];
    const listed = await callGatewayTool(
      { port: makePort({ profiles }), grants, profiles },
      "t3_list_profiles",
      { environmentId: "local" },
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        name: "Andy",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
      }),
    ]);
  });

  it("creates a thread from a Settings label-only profile using transient routing", async () => {
    const creates: Array<{
      instanceId?: string;
      model: string;
      runtimeMode: string;
      reasoningEffort?: string;
      profileId?: string;
    }> = [];
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        providerLabel: "Codex",
        modelLabel: "GPT-5.6 Sol",
        runtimeMode: "approval-required",
        interactionMode: "default",
        revision: 1,
      },
    ];

    await expect(
      callGatewayTool(
        { port: makePort({ profiles, creates }), grants, profiles },
        "t3_create_thread",
        {
          environmentId: "local",
          projectId: "local-project",
          title: "Resolved profile chat",
          profileId: "profile_andy",
          idempotencyKey: "label-only-create-1",
        },
      ),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(creates).toEqual([
      expect.objectContaining({ instanceId: "codex", model: "gpt-5.6-sol" }),
    ]);
  });

  it("rejects a disappeared or ambiguous label pair using readable text", async () => {
    const profiles: ReadonlyArray<GatewayProfile> = [
      {
        profileId: "profile_andy",
        name: "Andy",
        providerLabel: "Missing Codex",
        modelLabel: "Missing GPT",
        runtimeMode: "approval-required",
        interactionMode: "default",
        revision: 1,
      },
    ];
    await expect(
      callGatewayTool({ port: makePort({ profiles }), grants, profiles }, "t3_create_thread", {
        environmentId: "local",
        projectId: "local-project",
        title: "Resolved profile chat",
        profileId: "profile_andy",
        idempotencyKey: "label-only-create-2",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("provider: Missing Codex, model: Missing GPT"),
    });
  });
});
