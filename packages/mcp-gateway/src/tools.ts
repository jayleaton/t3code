import { GatewayError, type GatewayRuntimePort, type GatewayScope } from "./port.ts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type GatewayGrantSource = GatewayGrants | (() => GatewayGrants);

export interface GatewayToolContext {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
}

function currentGrants(source: GatewayGrantSource): GatewayGrants {
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
    case "t3_create_thread": {
      const environmentId = environmentWithScope(context, input, "create");
      const idempotencyKey = requiredString(input, "idempotencyKey");
      const modelSelection = record(input.modelSelection);
      return context.port.createThread({
        environmentId,
        projectId: requiredString(input, "projectId"),
        threadId: idFor("thread", idempotencyKey),
        title: requiredString(input, "title"),
        modelSelection: {
          instanceId: requiredString(modelSelection, "instanceId"),
          model: requiredString(modelSelection, "model"),
        },
        runtimeMode:
          input.runtimeMode === "auto-accept-edits" ||
          input.runtimeMode === "auto" ||
          input.runtimeMode === "full-access"
            ? input.runtimeMode
            : "approval-required",
        interactionMode: input.interactionMode === "plan" ? "plan" : "default",
        requestId: idFor("request", idempotencyKey),
      });
    }
    case "t3_send_message": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredString(input, "idempotencyKey");
      return context.port.sendMessage({
        environmentId,
        threadId: requiredString(input, "threadId"),
        text: requiredString(input, "text"),
        messageId: idFor("message", idempotencyKey),
        requestId: idFor("request", idempotencyKey),
      });
    }
    default:
      throw new GatewayError({
        code: "unknown_tool",
        message: `Unknown tool ${name}.`,
        retryable: false,
      });
  }
}
