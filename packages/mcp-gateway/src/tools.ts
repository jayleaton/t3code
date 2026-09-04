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

function requiredIdempotencyKey(input: Record<string, unknown>): string {
  return requiredString(input, "idempotencyKey");
}

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
    if (previous !== undefined) return previous;
  }
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
    case "t3_create_thread": {
      const environmentId = environmentWithScope(context, input, "create");
      const idempotencyKey = requiredIdempotencyKey(input);
      const profileName = typeof input.profile === "string" ? input.profile.trim() : "";
      const profile =
        profileName === ""
          ? undefined
          : currentProfiles(context.profiles).find((candidate) => candidate.name === profileName);
      if (profileName !== "" && profile === undefined) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Unknown gateway profile ${profileName}.`,
          retryable: false,
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
          context.events?.emit({
            environmentId,
            type: "thread.started",
            threadId: result.threadId,
            data: { title: requiredString(input, "title") },
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
          context.events?.emit({
            environmentId,
            type: "thread.progress",
            threadId: result.threadId,
            data: { messageId: result.messageId },
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
          context.events?.emit({
            environmentId,
            type: "thread.state_changed",
            threadId: result.threadId,
            data: { action },
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
          context.events?.emit({
            environmentId,
            type: "approval.updated",
            threadId: result.threadId,
            data: { approvalRequestId: requiredString(input, "approvalRequestId"), decision },
          });
          return result;
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
      const subscription = events.pendingFor(subscriptionId, 1);
      if (
        subscription[0]?.environmentId !== undefined &&
        subscription[0].environmentId !== environmentId
      ) {
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
      const environmentId = environmentWithScope(context, input, "read");
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
      environmentWithScope(context, input, "read");
      const types = Array.isArray(input.types)
        ? input.types.filter((t): t is string => typeof t === "string")
        : undefined;
      const patch = types === undefined ? {} : { types };
      return events.updateWebhook(requiredString(input, "webhookId"), patch);
    }
    case "t3_delete_webhook": {
      const events = requireEventStore(context);
      environmentWithScope(context, input, "read");
      events.deleteWebhook(requiredString(input, "webhookId"));
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
