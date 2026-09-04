import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { GatewayError, type GatewayRuntimePort } from "./port.ts";
import {
  callGatewayTool,
  type GatewayGrantSource,
  type GatewayProfileSource,
  type GatewayToolContext,
} from "./tools.ts";

const environmentId = z.string().trim().min(1);
const threadId = z.string().trim().min(1);
const idempotencyKey = z.string().trim().min(1).max(200);

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const body =
    error instanceof GatewayError
      ? error.toJSON()
      : {
          code: "upstream_failure",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function createMcpGateway(input: {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
  readonly events?: import("./events.ts").GatewayEventStore;
}) {
  const server = new McpServer({ name: "t3-code", version: "0.2.0" });
  const context: GatewayToolContext = input;
  const register = (name: string, description: string, inputSchema: z.ZodRawShape) => {
    server.registerTool(
      name,
      { description, inputSchema: z.strictObject(inputSchema) },
      async (args) => {
        try {
          return result(await callGatewayTool(context, name, args));
        } catch (error) {
          return failure(error);
        }
      },
    );
  };

  register("t3_list_environments", "List T3 environments granted to this host.", {});
  register("t3_get_environment_status", "Get connection state for one T3 environment.", {
    environmentId,
  });
  register("t3_list_projects", "List projects in one T3 environment.", { environmentId });
  register("t3_list_threads", "List chats in one T3 environment.", {
    environmentId,
    projectId: z.string().trim().min(1).optional(),
  });
  register("t3_get_thread", "Read one T3 chat and its messages.", { environmentId, threadId });
  register("t3_get_messages", "Read recent messages from one T3 chat.", {
    environmentId,
    threadId,
    limit: z.number().int().min(1).max(100).optional(),
  });
  register("t3_get_thread_history", "Read replayable progress events after a sequence cursor.", {
    environmentId,
    threadId,
    afterSequence: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  });
  register("t3_list_artifacts", "List message attachments and checkpoint files for one chat.", {
    environmentId,
    threadId,
  });
  register("t3_create_thread", "Create a chat in one T3 environment.", {
    environmentId,
    projectId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    profile: z.string().trim().min(1).optional(),
    modelSelection: z
      .object({ instanceId: z.string().trim().min(1), model: z.string().trim().min(1) })
      .strict()
      .optional(),
    runtimeMode: z
      .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
      .optional(),
    interactionMode: z.enum(["default", "plan"]).optional(),
    idempotencyKey,
  });
  register("t3_send_message", "Send a user message to an existing T3 chat.", {
    environmentId,
    threadId,
    text: z.string().trim().min(1),
    idempotencyKey,
  });
  register("t3_control_thread", "Cancel, stop, pause, resume, retry, or restart a T3 chat.", {
    environmentId,
    threadId,
    action: z.enum(["cancel", "stop", "pause", "resume", "retry", "restart"]),
    idempotencyKey,
  });
  register("t3_respond_to_approval", "Approve or reject a pending T3 action.", {
    environmentId,
    threadId,
    approvalRequestId: z.string().trim().min(1),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
    idempotencyKey,
  });
  register("t3_subscribe_events", "Create a durable event subscription with an optional cursor.", {
    environmentId,
    types: z.array(z.string().trim().min(1)).optional(),
    afterSequence: z.number().int().min(0).optional(),
  });
  register("t3_get_events", "Replay retained environment events after a sequence cursor.", {
    environmentId,
    afterSequence: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  });
  register("t3_ack_events", "Acknowledge processed events through a sequence, monotonically.", {
    environmentId,
    subscriptionId: z.string().trim().min(1),
    throughSequence: z.number().int().min(0),
  });
  register(
    "t3_register_webhook",
    "Register an HTTPS webhook for environment events; the signing secret is returned once.",
    {
      environmentId,
      url: z.string().trim().url(),
      types: z.array(z.string().trim().min(1)).optional(),
    },
  );
  register("t3_update_webhook", "Update an existing webhook's event filter.", {
    environmentId,
    webhookId: z.string().trim().min(1),
    types: z.array(z.string().trim().min(1)).optional(),
  });
  register("t3_delete_webhook", "Delete an existing webhook.", {
    environmentId,
    webhookId: z.string().trim().min(1),
  });
  register("t3_list_webhooks", "List registered webhooks for one T3 environment.", {
    environmentId,
  });

  return {
    server,
    connect: (transport: Transport) => server.connect(transport),
    close: () => server.close(),
  };
}
