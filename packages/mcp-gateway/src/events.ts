import * as DateTime from "effect/DateTime";

import * as NodeCrypto from "node:crypto";

import { GatewayError } from "./port.ts";

// Gatewaysidecar event store per the v3 product specification, section 7:
// immutable event payloads, per-environment monotonic sequences, bounded
// retention, cursor replay, and durable delivery state that is kept separate
// from event history.

export interface GatewayEvent {
  readonly eventId: string;
  readonly environmentId: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId?: string;
  readonly threadId?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface GatewaySubscription {
  readonly subscriptionId: string;
  readonly environmentId: string;
  readonly types?: ReadonlyArray<string>;
  readonly ackedSequence: number;
}

export interface GatewayWebhookConfig {
  readonly webhookId: string;
  readonly environmentId: string;
  readonly url: string;
  readonly types?: ReadonlyArray<string>;
  readonly secret: string;
  readonly ackedSequence: number;
}

interface EventRecord {
  readonly event: GatewayEvent;
  delivered: boolean;
}

export const MAX_WEBHOOK_RETRIES = 5;

function newId(prefix: string): string {
  return `${prefix}_${NodeCrypto.randomBytes(12).toString("hex")}`;
}

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

export function signWebhookPayload(secret: string, payload: string): string {
  return NodeCrypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export interface GatewayEventStoreInput {
  readonly retentionEvents?: number;
  readonly retentionDays?: number;
  readonly now?: () => string;
  readonly newEventId?: () => string;
}

export interface WebhookAttemptOutcome {
  readonly ok: boolean;
  readonly retryable: boolean;
}

export interface WebhookTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function createGatewayEventStore(input: GatewayEventStoreInput = {}) {
  const retentionEvents = input.retentionEvents ?? 100_000;
  const retentionMs = (input.retentionDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = input.now ?? nowIso;
  const newEventId = input.newEventId ?? (() => newId("evt"));

  const records = new Map<string, EventRecord>(); // eventId -> record
  const sequences = new Map<string, number>(); // environmentId -> last sequence
  const subscriptions = new Map<string, GatewaySubscription>();
  const webhooks = new Map<string, GatewayWebhookConfig>();
  const seenRequestIds = new Map<string, { payload: string; result: string }>(); // dedupe key -> attempt

  const emit = (event: {
    readonly environmentId: string;
    readonly type: string;
    readonly correlationId?: string;
    readonly threadId?: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }): GatewayEvent => {
    const sequence = (sequences.get(event.environmentId) ?? 0) + 1;
    const gatewayEvent: GatewayEvent = {
      eventId: newEventId(),
      environmentId: event.environmentId,
      sequence,
      type: event.type,
      occurredAt: now(),
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      data: event.data ?? {},
    };
    sequences.set(event.environmentId, sequence);
    records.set(gatewayEvent.eventId, { event: gatewayEvent, delivered: false });
    return gatewayEvent;
  };

  const matches = (filter: ReadonlyArray<string> | undefined, event: GatewayEvent): boolean =>
    filter === undefined || filter.includes(event.type);

  const trim = () => {
    const cutoffMs = Date.parse(now()) - retentionMs;
    for (const [eventId, record] of records) {
      if (records.size <= retentionEvents && Date.parse(record.event.occurredAt) >= cutoffMs) break;
      records.delete(eventId);
    }
  };

  return {
    emit,
    history: (
      environmentId: string,
      afterSequence: number,
      limit: number,
    ): ReadonlyArray<GatewayEvent> => {
      trim();
      return [...records.values()]
        .map((record) => record.event)
        .filter((event) => event.environmentId === environmentId && event.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit);
    },
    latestSequence: (environmentId: string): number => sequences.get(environmentId) ?? 0,
    markDelivered: (eventId: string) => {
      const record = records.get(eventId);
      if (record !== undefined) record.delivered = true;
    },
    subscribe: (input2: {
      readonly environmentId: string;
      readonly types?: ReadonlyArray<string>;
      readonly afterSequence?: number;
    }): GatewaySubscription => {
      const subscription: GatewaySubscription = {
        subscriptionId: newId("sub"),
        environmentId: input2.environmentId,
        ...(input2.types === undefined ? {} : { types: [...input2.types] }),
        ackedSequence: input2.afterSequence ?? 0,
      };
      subscriptions.set(subscription.subscriptionId, subscription);
      return subscription;
    },
    ack: (subscriptionId: string, throughSequence: number): GatewaySubscription => {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription === undefined) {
        throw new GatewayError({
          code: "unknown_subscription",
          message: `Unknown subscription ${subscriptionId}.`,
          retryable: false,
        });
      }
      if (!Number.isInteger(throughSequence) || throughSequence < 0) {
        throw new GatewayError({
          code: "invalid_input",
          message: "throughSequence must be a non-negative integer.",
          retryable: false,
        });
      }
      // Acknowledgements are monotonic and idempotent.
      const next: GatewaySubscription = {
        ...subscription,
        ackedSequence: Math.max(subscription.ackedSequence, throughSequence),
      };
      subscriptions.set(subscriptionId, next);
      return next;
    },
    pendingFor: (subscriptionId: string, limit: number): ReadonlyArray<GatewayEvent> => {
      const subscription = subscriptions.get(subscriptionId);
      if (subscription === undefined) {
        throw new GatewayError({
          code: "unknown_subscription",
          message: `Unknown subscription ${subscriptionId}.`,
          retryable: false,
        });
      }
      return [...records.values()]
        .map((record) => record.event)
        .filter(
          (event) =>
            event.environmentId === subscription.environmentId &&
            event.sequence > subscription.ackedSequence &&
            matches(subscription.types, event),
        )
        .sort((left, right) => left.sequence - right.sequence)
        .slice(0, limit);
    },
    registerWebhook: (input2: {
      readonly environmentId: string;
      readonly url: string;
      readonly types?: ReadonlyArray<string>;
    }): { readonly webhook: GatewayWebhookConfig; readonly secret: string } => {
      if (!input2.url.startsWith("https://")) {
        throw new GatewayError({
          code: "invalid_input",
          message: "Webhook URLs must use HTTPS.",
          retryable: false,
        });
      }
      const secret = NodeCrypto.randomBytes(24).toString("hex");
      const webhook: GatewayWebhookConfig = {
        webhookId: newId("whk"),
        environmentId: input2.environmentId,
        url: input2.url,
        ...(input2.types === undefined ? {} : { types: [...input2.types] }),
        secret,
        ackedSequence: 0,
      };
      webhooks.set(webhook.webhookId, webhook);
      // The secret is returned once at registration; later reads expose only a reference.
      return { webhook: { ...webhook, secret: "" }, secret };
    },
    updateWebhook: (webhookId: string, patch: { readonly types?: ReadonlyArray<string> }) => {
      const webhook = webhooks.get(webhookId);
      if (webhook === undefined) {
        throw new GatewayError({
          code: "unknown_webhook",
          message: `Unknown webhook ${webhookId}.`,
          retryable: false,
        });
      }
      const next: GatewayWebhookConfig = {
        ...webhook,
        ...(patch.types === undefined ? {} : { types: [...patch.types] }),
      };
      webhooks.set(webhookId, next);
      return { ...next, secret: "" };
    },
    deleteWebhook: (webhookId: string): void => {
      if (!webhooks.delete(webhookId)) {
        throw new GatewayError({
          code: "unknown_webhook",
          message: `Unknown webhook ${webhookId}.`,
          retryable: false,
        });
      }
    },
    listWebhooks: (environmentId?: string): ReadonlyArray<GatewayWebhookConfig> =>
      [...webhooks.values()]
        .filter((webhook) => environmentId === undefined || webhook.environmentId === environmentId)
        .map((webhook) => ({ ...webhook, secret: "" })),
    webhookById: (webhookId: string): GatewayWebhookConfig | undefined => webhooks.get(webhookId),
    // Builds a delivery target for one webhook. Returns undefined when the event
    // does not match the webhook filter or already has a delivery in flight
    // (at-least-once with in-flight dedupe; delivery completes on ack).
    buildDelivery: (webhookId: string, event: GatewayEvent): WebhookTarget | undefined => {
      const webhook = webhooks.get(webhookId);
      if (
        webhook === undefined ||
        webhook.environmentId !== event.environmentId ||
        !matches(webhook.types, event)
      ) {
        return undefined;
      }
      const record = records.get(event.eventId);
      if (record === undefined || record.delivered) return undefined;
      record.delivered = true;
      const body = JSON.stringify(event);
      return {
        url: webhook.url,
        body,
        headers: {
          "Content-Type": "application/json",
          "X-T3-Event-Id": event.eventId,
          "X-T3-Event-Sequence": String(event.sequence),
          "X-T3-Correlation-Id": event.correlationId ?? "",
          "X-T3-Signature": `sha256=${signWebhookPayload(webhook.secret, body)}`,
        },
      };
    },
    ackWebhookDelivery: (webhookId: string, eventId: string): GatewayWebhookConfig => {
      const webhook = webhooks.get(webhookId);
      const record = records.get(eventId);
      if (webhook === undefined || record === undefined) {
        throw new GatewayError({
          code: "unknown_webhook",
          message: `Unknown webhook ${webhookId} or event ${eventId}.`,
          retryable: false,
        });
      }
      if (record.event.environmentId !== webhook.environmentId) {
        throw new GatewayError({
          code: "invalid_input",
          message: "Event does not belong to the webhook environment.",
          retryable: false,
        });
      }
      record.delivered = true;
      const next: GatewayWebhookConfig = {
        ...webhook,
        ackedSequence: Math.max(webhook.ackedSequence, record.event.sequence),
      };
      webhooks.set(webhookId, next);
      return { ...next, secret: "" };
    },
    // Request-id idempotency memory for mutating commands (spec section 6.2).
    // Repeating the same (environmentId, threadId, requestId) with the same
    // payload replays the original result; a different payload under the same
    // key is a conflict. Returns "accepted" on first sight, "duplicate" when
    // the stored payload matches, and "conflict" when it differs.
    rememberRequest: (
      key: string,
      payload: string,
      result: unknown,
    ): "accepted" | "duplicate" | "conflict" => {
      const stored = seenRequestIds.get(key);
      if (stored !== undefined) return stored.payload === payload ? "duplicate" : "conflict";
      seenRequestIds.set(key, { payload, result: JSON.stringify(result ?? null) });
      return "accepted";
    },
    recallRequest: <T>(key: string): T | undefined => {
      const stored = seenRequestIds.get(key);
      return stored === undefined ? undefined : (JSON.parse(stored.result) as T);
    },
    forgetRequest: (key: string): void => {
      seenRequestIds.delete(key);
    },
  };
}

export type GatewayEventStore = ReturnType<typeof createGatewayEventStore>;
