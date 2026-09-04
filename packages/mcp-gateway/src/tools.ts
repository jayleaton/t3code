import {
  GatewayError,
  type GatewayApprovalDecision,
  type GatewayProfile,
  type GatewayRuntimePort,
  type GatewayScope,
  type GatewayThreadControlAction,
} from "./port.ts";
import type { GatewayEventStore } from "./events.ts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type GatewayGrantSource = GatewayGrants | (() => GatewayGrants);
export type GatewayProfileSource =
  | ReadonlyArray<GatewayProfile>
  | (() => ReadonlyArray<GatewayProfile>);

export interface GatewayToolContext {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
  readonly events?: GatewayEventStore;
}

function currentGrants(source: GatewayGrantSource): GatewayGrants {
  return typeof source === "function" ? source() : source;
}

function currentProfiles(source: GatewayProfileSource | undefined): ReadonlyArray<GatewayProfile> {
  if (source === undefined) return [];
  return typeof source === "function" ? source() : source;
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Tool input must be an object.",
      retryable: false,
    });
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GatewayError({
      code: "invalid_input",
      message: `${key} must be a non-empty string.`,
      retryable: false,
    });
  }
  return value;
}

function environmentWithScope(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  scope: GatewayScope,
): string {
  const environmentId = requiredString(input, "environmentId");
  const scopes = currentGrants(context.grants)[environmentId];
  if (scopes === undefined) {
    throw new GatewayError({
      code: "unknown_environment",
      message: `Environment ${environmentId} is not granted to this host.`,
      retryable: false,
      environmentId,
    });
  }
  if (!scopes.includes(scope)) {
    throw new GatewayError({
      code: "scope_required",
      message: `Scope ${scope} is required for environment ${environmentId}.`,
      retryable: false,
      environmentId,
      details: { requiredScope: scope },
    });
  }
  return environmentId;
}

function idFor(kind: string, idempotencyKey: string): string {
  return `mcp-${kind}-${idempotencyKey}`;
}

function requireEventStore(context: GatewayToolContext): GatewayEventStore {
  if (context.events === undefined) {
    throw new GatewayError({
      code: "not_configured",
      message: "Event delivery is not configured for this gateway.",
      retryable: false,
    });
  }
  return context.events;
}

// Stable canonical JSON for idempotency payload comparison: unknown fields and
// key order must not turn a retry into a conflict.
function stablePayload(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stablePayload(item)}`).join(",")}}`;
}

function approvalPlan(thread: Record<string, unknown>) {
  const pending = new Map<string, Record<string, unknown>>();
  const activities = (Array.isArray(thread.activities) ? thread.activities : []).toSorted(
    (left, right) => {
      const leftSequence =
        typeof left === "object" && left !== null && "sequence" in left ? Number(left.sequence) : 0;
      const rightSequence =
        typeof right === "object" && right !== null && "sequence" in right
          ? Number(right.sequence)
          : 0;
      return leftSequence - rightSequence;
    },
  );
  let revision = 0;
  for (const candidate of activities) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const activity = candidate as Record<string, unknown>;
    const payload =
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      !Array.isArray(activity.payload)
        ? (activity.payload as Record<string, unknown>)
        : {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
    if (typeof activity.sequence === "number") revision = Math.max(revision, activity.sequence);
    if (requestId === undefined) continue;
    if (activity.kind === "approval.requested") {
      const requestKind = typeof payload.requestKind === "string" ? payload.requestKind : "command";
      pending.set(requestId, {
        approvalActionId: requestId,
        requestKind,
        detail: typeof payload.detail === "string" ? payload.detail : "Approval requested",
        risk: requestKind === "file-read" ? "low" : "high",
        reversible: requestKind !== "command",
        requiresDestructiveConfirmation: requestKind === "command" || requestKind === "file-change",
        modifiableFields: [],
      });
    } else if (activity.kind === "approval.resolved") {
      pending.delete(requestId);
    }
  }
  const threadId = typeof thread.id === "string" ? thread.id : "unknown";
  return {
    approvalPlanId: `plan-${threadId}`,
    revision,
    actions: [...pending.values()],
  };
}

function requiredStringArray(input: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const value = input[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: `${key} must be a non-empty array of strings.`,
      retryable: false,
    });
  }
  return value as ReadonlyArray<string>;
}

function pullRequestRef(input: Record<string, unknown>) {
  const number = Number(input.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new GatewayError({
      code: "invalid_input",
      message: "number must be a positive integer.",
      retryable: false,
    });
  }
  return {
    projectId: requiredString(input, "projectId"),
    repository: requiredString(input, "repository"),
    number,
  };
}

function requiredIdempotencyKey(input: Record<string, unknown>): string {
  return requiredString(input, "idempotencyKey");
}

const pendingRequests = new WeakMap<GatewayEventStore, Map<string, Promise<unknown>>>();

// Memoizes a mutating command per (environmentId, threadId, requestId). On a
// first attempt it runs the operation and stores the receipt; a same-payload
// retry replays the stored receipt; a different payload is idempotency_conflict.
async function withIdempotency(
  context: GatewayToolContext,
  key: string,
  payload: unknown,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  // Additive v3 behavior: without an event store the command runs directly,
  // preserving the v1 single-shot semantics.
  if (context.events === undefined) return operation();
  const events = context.events;
  let pending = pendingRequests.get(events);
  if (pending === undefined) {
    pending = new Map();
    pendingRequests.set(events, pending);
  }
  const canonical = stablePayload(payload);
  const outcome = events.rememberRequest(key, canonical, null);
  if (outcome === "conflict") {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "This request id was already used with a different payload.",
      retryable: false,
      requestId: key,
    });
  }
  if (outcome === "duplicate") {
    const previous = events.recallRequest(key);
    if (previous !== undefined && previous !== null) return previous;
    const active = pending.get(key);
    if (active !== undefined) return active;
    throw new GatewayError({
      code: "request_in_progress",
      message: "This request id is recovering after an interrupted execution; retry it.",
      retryable: true,
      requestId: key,
    });
  }
  const execution = (async () => {
    try {
      const result = await operation();
      events.forgetRequest(key);
      events.rememberRequest(key, canonical, result);
      return result;
    } catch (error) {
      // Failed attempts release the key so a corrected retry is possible.
      events.forgetRequest(key);
      throw error;
    }
  })();
  pending.set(key, execution);
  try {
    return await execution;
  } finally {
    pending.delete(key);
  }
}

export async function callGatewayTool(
  context: GatewayToolContext,
  name: string,
  rawInput: unknown,
): Promise<any> {
  const input = record(rawInput);
  switch (name) {
    case "t3_list_environments": {
      const environments = await context.port.listEnvironments();
      const grants = currentGrants(context.grants);
      return {
        items: environments.filter(
          (environment) => grants[environment.environmentId] !== undefined,
        ),
        snapshotAt: "runtime",
      };
    }
    case "t3_get_environment_status": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getEnvironmentStatus(environmentId);
    }
    case "t3_list_projects": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.listProjects(environmentId);
    }
    case "t3_list_threads": {
      const environmentId = environmentWithScope(context, input, "read");
      const page = await context.port.listThreads(environmentId);
      const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
      return projectId === undefined
        ? page
        : { ...page, items: page.items.filter((thread) => thread.projectId === projectId) };
    }
    case "t3_get_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_summarize_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const plan = approvalPlan(thread);
      const session =
        typeof thread.session === "object" && thread.session !== null
          ? (thread.session as Record<string, unknown>)
          : null;
      const latestTurn =
        typeof thread.latestTurn === "object" && thread.latestTurn !== null
          ? (thread.latestTurn as Record<string, unknown>)
          : null;
      const status =
        plan.actions.length > 0
          ? "waiting-approval"
          : typeof latestTurn?.state === "string"
            ? latestTurn.state
            : typeof session?.status === "string"
              ? session.status
              : "queued";
      return {
        environmentId,
        threadId: thread.id,
        title: thread.title,
        status,
        summary: session?.lastError ?? `Thread is ${status}.`,
        blockers: plan.actions,
        approvalPlan: plan,
        artifacts: Array.isArray(thread.checkpoints) ? thread.checkpoints : [],
        nextAction:
          plan.actions.length > 0 ? "approve_actions" : status === "running" ? "await_event" : null,
        snapshotAt: thread.updatedAt ?? "runtime",
      };
    }
    case "t3_list_profiles": {
      const environmentId = environmentWithScope(context, input, "read");
      return {
        items: currentProfiles(context.profiles).filter(
          (profile) =>
            !Array.isArray(profile.environmentIds) ||
            profile.environmentIds.includes(environmentId),
        ),
        snapshotAt: "runtime",
      };
    }
    case "t3_get_approval_plan": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      return approvalPlan(thread);
    }
    case "t3_get_messages": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const requestedLimit = typeof input.limit === "number" ? input.limit : 100;
      const limit = Math.max(1, Math.min(100, Math.trunc(requestedLimit)));
      return {
        items: messages.slice(-limit),
        snapshotAt: typeof thread.updatedAt === "string" ? thread.updatedAt : "runtime",
      };
    }
    case "t3_get_thread_history": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const afterSequence =
        typeof input.afterSequence === "number" ? Math.max(0, Math.trunc(input.afterSequence)) : 0;
      const requestedLimit = typeof input.limit === "number" ? input.limit : 200;
      const limit = Math.max(1, Math.min(500, Math.trunc(requestedLimit)));
      const activities = (Array.isArray(thread.activities) ? thread.activities : [])
        .filter(
          (activity): activity is Record<string, unknown> =>
            typeof activity === "object" &&
            activity !== null &&
            !Array.isArray(activity) &&
            typeof (activity as Record<string, unknown>).sequence === "number" &&
            ((activity as Record<string, unknown>).sequence as number) > afterSequence,
        )
        .slice(0, limit);
      const lastSequence = activities.at(-1)?.sequence;
      return {
        items: activities,
        ...(typeof lastSequence === "number" ? { nextCursor: String(lastSequence) } : {}),
      };
    }
    case "t3_list_artifacts": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const items: Array<Record<string, unknown>> = [];
      for (const message of Array.isArray(thread.messages) ? thread.messages : []) {
        if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
        const value = message as Record<string, unknown>;
        for (const artifact of Array.isArray(value.attachments) ? value.attachments : []) {
          items.push({ source: "message", messageId: value.id, artifact });
        }
      }
      for (const checkpoint of Array.isArray(thread.checkpoints) ? thread.checkpoints : []) {
        if (typeof checkpoint !== "object" || checkpoint === null || Array.isArray(checkpoint))
          continue;
        const value = checkpoint as Record<string, unknown>;
        for (const artifact of Array.isArray(value.files) ? value.files : []) {
          items.push({ source: "checkpoint", turnId: value.turnId, artifact });
        }
      }
      return { items };
    }
    case "t3_get_artifact": {
      const environmentId = environmentWithScope(context, input, "read");
      const threadId = requiredString(input, "threadId");
      const artifactId = requiredString(input, "artifactId");
      const thread = await context.port.getThread(environmentId, threadId);
      const kind = requiredString(input, "kind");
      if (kind === "attachment") {
        const belongsToThread = (Array.isArray(thread.messages) ? thread.messages : []).some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            !Array.isArray(message) &&
            (Array.isArray((message as Record<string, unknown>).attachments)
              ? ((message as Record<string, unknown>).attachments as ReadonlyArray<unknown>)
              : []
            ).some(
              (attachment) =>
                typeof attachment === "object" &&
                attachment !== null &&
                !Array.isArray(attachment) &&
                (attachment as Record<string, unknown>).id === artifactId,
            ),
        );
        if (!belongsToThread) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Artifact ${artifactId} does not belong to thread ${threadId}.`,
            retryable: false,
            environmentId,
          });
        }
        const download = await context.port.createAssetUrl(environmentId, {
          _tag: "attachment",
          attachmentId: artifactId,
        });
        return { artifactId, environmentId, threadId, availability: "available", download };
      }
      if (kind === "workspace-file") {
        const path = requiredString(input, "path");
        const belongsToThread = (Array.isArray(thread.checkpoints) ? thread.checkpoints : []).some(
          (checkpoint) =>
            typeof checkpoint === "object" &&
            checkpoint !== null &&
            !Array.isArray(checkpoint) &&
            (Array.isArray((checkpoint as Record<string, unknown>).files)
              ? ((checkpoint as Record<string, unknown>).files as ReadonlyArray<unknown>)
              : []
            ).some(
              (file) =>
                typeof file === "object" &&
                file !== null &&
                !Array.isArray(file) &&
                (file as Record<string, unknown>).path === path,
            ),
        );
        if (!belongsToThread) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Workspace artifact ${path} does not belong to thread ${threadId}.`,
            retryable: false,
            environmentId,
          });
        }
        const download = await context.port.createAssetUrl(environmentId, {
          _tag: "workspace-file",
          threadId,
          path,
        });
        return { artifactId, environmentId, threadId, availability: "available", download };
      }
      throw new GatewayError({
        code: "invalid_input",
        message: `Unsupported artifact kind ${kind}.`,
        retryable: false,
        environmentId,
      });
    }
    case "t3_get_pr": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getPullRequest(environmentId, pullRequestRef(input));
    }
    case "t3_get_pr_checks": {
      const environmentId = environmentWithScope(context, input, "read");
      const detail = await context.port.getPullRequest(environmentId, pullRequestRef(input));
      return { items: Array.isArray(detail.checks) ? detail.checks : [] };
    }
    case "t3_list_review_comments": {
      const environmentId = environmentWithScope(context, input, "read");
      const activity = await context.port.getPullRequestActivity(
        environmentId,
        pullRequestRef(input),
      );
      const items = (Array.isArray(activity.reviewThreads) ? activity.reviewThreads : []).filter(
        (thread): thread is Record<string, unknown> =>
          typeof thread === "object" &&
          thread !== null &&
          !Array.isArray(thread) &&
          (thread as Record<string, unknown>).isResolved !== true,
      );
      return { items, unresolvedCount: items.length };
    }
    case "t3_create_thread": {
      const environmentId = environmentWithScope(context, input, "create");
      const idempotencyKey = requiredIdempotencyKey(input);
      const profileName = typeof input.profile === "string" ? input.profile.trim() : "";
      const profileId = typeof input.profileId === "string" ? input.profileId.trim() : "";
      const profile =
        profileId !== ""
          ? currentProfiles(context.profiles).find((candidate) => candidate.profileId === profileId)
          : profileName === ""
            ? undefined
            : currentProfiles(context.profiles).find((candidate) => candidate.name === profileName);
      if ((profileName !== "" || profileId !== "") && profile === undefined) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Unknown gateway profile ${profileId || profileName}.`,
          retryable: false,
        });
      }
      if (
        profile !== undefined &&
        Array.isArray(profile.environmentIds) &&
        !profile.environmentIds.includes(environmentId)
      ) {
        throw new GatewayError({
          code: "scope_required",
          message: `Profile ${profile.name} is not allowed in environment ${environmentId}.`,
          retryable: false,
          environmentId,
          details: { profileId: profile.profileId, permission: "environment-allowlist" },
        });
      }
      if (profile?.runtimeMode === "read-only") {
        throw new GatewayError({
          code: "scope_required",
          message: `Profile ${profile.name} is read-only and cannot create a thread.`,
          retryable: false,
          environmentId,
          details: { profileId: profile.profileId, permission: "read-only" },
        });
      }
      const rawModelSelection = input.modelSelection ?? profile?.modelSelection;
      const modelSelection = record(rawModelSelection);
      const requestedRuntimeMode = input.runtimeMode ?? profile?.runtimeMode;
      const requestedInteractionMode = input.interactionMode ?? profile?.interactionMode;
      return withIdempotency(
        context,
        `${environmentId}::${idFor("thread", idempotencyKey)}`,
        input,
        async () => {
          const result = await context.port.createThread({
            environmentId,
            projectId: requiredString(input, "projectId"),
            threadId: idFor("thread", idempotencyKey),
            title: requiredString(input, "title"),
            modelSelection: {
              instanceId: requiredString(modelSelection, "instanceId"),
              model: requiredString(modelSelection, "model"),
            },
            runtimeMode:
              requestedRuntimeMode === "auto-accept-edits" ||
              requestedRuntimeMode === "auto" ||
              requestedRuntimeMode === "full-access"
                ? requestedRuntimeMode
                : "approval-required",
            interactionMode: requestedInteractionMode === "plan" ? "plan" : "default",
            requestId: idFor("request", idempotencyKey),
          });
          return result;
        },
      );
    }
    case "t3_send_message": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredIdempotencyKey(input);
      return withIdempotency(
        context,
        `${environmentId}::${requiredString(input, "threadId")}::${idFor("request", idempotencyKey)}`,
        input,
        async () => {
          const result = await context.port.sendMessage({
            environmentId,
            threadId: requiredString(input, "threadId"),
            text: requiredString(input, "text"),
            messageId: idFor("message", idempotencyKey),
            requestId: idFor("request", idempotencyKey),
          });
          return result;
        },
      );
    }
    case "t3_control_thread": {
      const environmentId = environmentWithScope(context, input, "control");
      const idempotencyKey = requiredIdempotencyKey(input);
      const rawAction = requiredString(input, "action");
      if (
        !(["cancel", "stop", "pause", "resume", "retry", "restart"] as const).some(
          (value) => value === rawAction,
        )
      ) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Unsupported thread control action ${rawAction}.`,
          retryable: false,
        });
      }
      const action = rawAction as GatewayThreadControlAction;
      return withIdempotency(
        context,
        `${environmentId}::${requiredString(input, "threadId")}::${idFor("request", idempotencyKey)}`,
        input,
        async () => {
          const result = await context.port.controlThread({
            environmentId,
            threadId: requiredString(input, "threadId"),
            action,
            requestId: idFor("request", idempotencyKey),
            messageId: idFor("message", idempotencyKey),
          });
          return result;
        },
      );
    }
    case "t3_respond_to_approval": {
      const environmentId = environmentWithScope(context, input, "control");
      const idempotencyKey = requiredIdempotencyKey(input);
      const rawDecision = requiredString(input, "decision");
      if (
        !(["accept", "acceptForSession", "decline", "cancel"] as const).some(
          (value) => value === rawDecision,
        )
      ) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Unsupported approval decision ${rawDecision}.`,
          retryable: false,
        });
      }
      const decision = rawDecision as GatewayApprovalDecision;
      return withIdempotency(
        context,
        `${environmentId}::${requiredString(input, "threadId")}::${idFor("request", idempotencyKey)}`,
        input,
        async () => {
          const result = await context.port.respondToApproval({
            environmentId,
            threadId: requiredString(input, "threadId"),
            approvalRequestId: requiredString(input, "approvalRequestId"),
            decision,
            requestId: idFor("request", idempotencyKey),
          });
          return result;
        },
      );
    }
    case "t3_approve_actions":
    case "t3_reject_actions": {
      const environmentId = environmentWithScope(context, input, "control");
      const threadId = requiredString(input, "threadId");
      const idempotencyKey = requiredIdempotencyKey(input);
      const actionIds = requiredStringArray(input, "actionIds");
      const thread = await context.port.getThread(environmentId, threadId);
      const plan = approvalPlan(thread);
      const requestedRevision = Number(input.planRevision);
      if (!Number.isInteger(requestedRevision) || requestedRevision !== plan.revision) {
        throw new GatewayError({
          code: "stale_plan",
          message: `Approval plan changed from revision ${String(input.planRevision)} to ${plan.revision}.`,
          retryable: false,
          environmentId,
          details: { approvalPlanId: plan.approvalPlanId, currentRevision: plan.revision },
        });
      }
      const selected = plan.actions.filter((action) =>
        actionIds.includes(action.approvalActionId as string),
      );
      if (selected.length !== actionIds.length) {
        throw new GatewayError({
          code: "invalid_input",
          message: "One or more approval action IDs are not pending in this plan.",
          retryable: false,
          environmentId,
        });
      }
      if (
        name === "t3_approve_actions" &&
        input.confirmDestructive !== true &&
        selected.some((action) => action.requiresDestructiveConfirmation === true)
      ) {
        throw new GatewayError({
          code: "destructive_confirmation_required",
          message: "One or more selected actions require confirmDestructive: true.",
          retryable: false,
          environmentId,
        });
      }
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("approval-plan", idempotencyKey)}`,
        input,
        async () => {
          const decision: GatewayApprovalDecision =
            name === "t3_approve_actions" ? "accept" : "decline";
          const results = [];
          for (const action of selected) {
            results.push(
              await context.port.respondToApproval({
                environmentId,
                threadId,
                approvalRequestId: action.approvalActionId as string,
                decision,
                requestId: `${idFor("request", idempotencyKey)}-${String(action.approvalActionId)}`,
              }),
            );
          }
          return {
            approvalPlanId: plan.approvalPlanId,
            revision: plan.revision,
            approved: decision === "accept" ? results.length : 0,
            rejected: decision === "decline" ? results.length : 0,
            pending: plan.actions.length - results.length,
            results,
          };
        },
      );
    }
    case "t3_subscribe_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const types = Array.isArray(input.types)
        ? input.types.filter((candidate): candidate is string => typeof candidate === "string")
        : undefined;
      const subscription = events.subscribe({
        environmentId,
        ...(types === undefined ? {} : { types }),
        ...(typeof input.afterSequence === "number"
          ? { afterSequence: Math.max(0, Math.trunc(input.afterSequence)) }
          : {}),
      });
      return {
        subscriptionId: subscription.subscriptionId,
        environmentId: subscription.environmentId,
        ...(subscription.types === undefined ? {} : { types: subscription.types }),
        ackedSequence: subscription.ackedSequence,
      };
    }
    case "t3_get_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const afterSequence =
        typeof input.afterSequence === "number" ? Math.max(0, Math.trunc(input.afterSequence)) : 0;
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 200;
      const history = events.history(environmentId, afterSequence, limit);
      return {
        items: history,
        latestSequence: events.latestSequence(environmentId),
        hasMore: history.length === limit,
      };
    }
    case "t3_ack_events": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const subscriptionId = requiredString(input, "subscriptionId");
      const subscription = events.subscriptionById(subscriptionId);
      if (subscription === undefined || subscription.environmentId !== environmentId) {
        throw new GatewayError({
          code: "unknown_subscription",
          message: `Subscription ${subscriptionId} does not belong to environment ${environmentId}.`,
          retryable: false,
          environmentId,
        });
      }
      const acked = events.ack(subscriptionId, Math.trunc(Number(input.throughSequence)));
      return { subscriptionId: acked.subscriptionId, ackedSequence: acked.ackedSequence };
    }
    case "t3_register_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "delivery");
      const { webhook, secret } = events.registerWebhook({
        environmentId,
        url: requiredString(input, "url"),
        ...(Array.isArray(input.types)
          ? { types: input.types.filter((t): t is string => typeof t === "string") }
          : {}),
      });
      return { ...webhook, secret, secretReference: `webhook-secret/${webhook.webhookId}` };
    }
    case "t3_update_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "delivery");
      const types = Array.isArray(input.types)
        ? input.types.filter((t): t is string => typeof t === "string")
        : undefined;
      const patch = types === undefined ? {} : { types };
      return events.updateWebhook(environmentId, requiredString(input, "webhookId"), patch);
    }
    case "t3_rotate_webhook_secret": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "delivery");
      const { webhook, secret } = events.rotateWebhookSecret(
        environmentId,
        requiredString(input, "webhookId"),
      );
      return { ...webhook, secret, secretReference: `webhook-secret/${webhook.webhookId}` };
    }
    case "t3_delete_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "delivery");
      events.deleteWebhook(environmentId, requiredString(input, "webhookId"));
      return { deleted: true };
    }
    case "t3_list_webhooks": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      return { items: events.listWebhooks(environmentId) };
    }
    default:
      throw new GatewayError({
        code: "unknown_tool",
        message: `Unknown tool ${name}.`,
        retryable: false,
      });
  }
}
