import { describe, expect, it } from "@effect/vitest";

import { createGatewayEventStore, isPrivateWebhookAddress, signWebhookPayload } from "./events.ts";

const clock = { value: "2026-09-03T12:00:00.000Z" };
let counter = 0;

function makeStore() {
  counter = 0;
  clock.value = "2026-09-03T12:00:00.000Z";
  return createGatewayEventStore({
    file: ":memory:",
    now: () => clock.value,
    newEventId: () => `evt-${++counter}`,
  });
}

describe("gateway event store", () => {
  it("assigns monotonic per-environment sequences and replays in order", () => {
    const store = makeStore();
    store.emit({ environmentId: "env-1", type: "thread.started" });
    store.emit({ environmentId: "env-2", type: "thread.started" });
    const third = store.emit({ environmentId: "env-1", type: "thread.completed" });

    expect(store.latestSequence("env-1")).toBe(2);
    expect(store.latestSequence("env-2")).toBe(1);
    expect(third.sequence).toBe(2);

    const replay = store.history("env-1", 0, 10);
    expect(replay.map((event) => event.sequence)).toEqual([1, 2]);
    expect(store.history("env-1", 1, 10).map((event) => event.sequence)).toEqual([2]);
  });

  it("marks deliveries and honours retention limits", () => {
    const store = createGatewayEventStore({
      file: ":memory:",
      retentionEvents: 2,
      retentionDays: 7,
      now: () => clock.value,
      newEventId: () => `evt-${++counter}`,
    });
    store.emit({ environmentId: "env-1", type: "a" });
    store.emit({ environmentId: "env-1", type: "b" });
    store.emit({ environmentId: "env-1", type: "c" });

    expect(() => store.history("env-1", 0, 10)).toThrowError(
      expect.objectContaining({ code: "cursor_expired" }),
    );
    expect(store.history("env-1", 1, 10).map((event) => event.type)).toEqual(["b", "c"]);
  });

  it("keeps subscriptions with monotonic idempotent acks and typed cursors", () => {
    const store = makeStore();
    store.emit({ environmentId: "env-1", type: "thread.started" });
    const subscription = store.subscribe({ environmentId: "env-1" });

    const pending = store.pendingFor(subscription.subscriptionId, 10);
    expect(pending.map((event) => event.sequence)).toEqual([1]);

    store.ack(subscription.subscriptionId, 1);
    expect(store.pendingFor(subscription.subscriptionId, 10)).toEqual([]);
    // Idempotent + monotonic: older or repeated acks never regress the cursor.
    store.ack(subscription.subscriptionId, 1);
    store.ack(subscription.subscriptionId, 0);
    expect(store.pendingFor(subscription.subscriptionId, 10)).toEqual([]);

    expect(() => store.ack("sub-missing", 3)).toThrowError(
      expect.objectContaining({ code: "unknown_subscription" }),
    );
    expect(() => store.ack(subscription.subscriptionId, -1)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("filters subscription events by type", () => {
    const store = makeStore();
    store.emit({ environmentId: "env-1", type: "thread.progress" });
    store.emit({ environmentId: "env-1", type: "approval.requested" });
    const subscription = store.subscribe({ environmentId: "env-1", types: ["approval.requested"] });

    expect(store.pendingFor(subscription.subscriptionId, 10).map((event) => event.type)).toEqual([
      "approval.requested",
    ]);
  });

  it("registers webhooks, returns the secret once, and signs deliveries", () => {
    const store = makeStore();
    const { webhook, secret } = store.registerWebhook({
      environmentId: "env-1",
      url: "https://example.com/hook",
    });
    expect(secret).not.toBe("");
    expect(webhook.secret).toBe("");
    expect(store.listWebhooks("env-1")[0]?.secret).toBe("");

    const event = store.emit({
      environmentId: "env-1",
      type: "thread.completed",
      correlationId: "corr-1",
    });
    const delivery = store.buildDelivery(webhook.webhookId, event.eventId);
    expect(delivery).toBeDefined();
    expect(delivery?.headers["X-T3-Event-Id"]).toBe(event.eventId);
    expect(delivery?.headers["X-T3-Event-Sequence"]).toBe(String(event.sequence));
    expect(delivery?.headers["X-T3-Correlation-Id"]).toBe("corr-1");
    expect(delivery?.headers["X-T3-Signature"]).toBe(
      `sha256=${signWebhookPayload(secret, delivery?.body ?? "")}`,
    );

    // Dedupe: a second build for the same event is delayed until the attempt is reported.
    expect(store.buildDelivery(webhook.webhookId, event.eventId)).toBeUndefined();
    store.reportDeliveryAttempt(webhook.webhookId, event.eventId, {
      ok: true,
      retryable: false,
    });
    expect(store.webhookById(webhook.webhookId)?.ackedSequence).toBe(event.sequence);
  });

  it("rejects non-HTTPS webhook URLs and unknown webhook operations", () => {
    const store = makeStore();
    expect(() =>
      store.registerWebhook({ environmentId: "env-1", url: "http://example.com/hook" }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(() => store.updateWebhook("env-1", "whk-missing", {})).toThrowError(
      expect.objectContaining({ code: "unknown_webhook" }),
    );
    expect(() => store.deleteWebhook("env-1", "whk-missing")).toThrowError(
      expect.objectContaining({ code: "unknown_webhook" }),
    );
  });

  it("filters webhook deliveries by type and environment", () => {
    const store = makeStore();
    const { webhook } = store.registerWebhook({
      environmentId: "env-1",
      url: "https://example.com/hook",
      types: ["approval.requested"],
    });
    const progress = store.emit({ environmentId: "env-1", type: "thread.progress" });
    const approval = store.emit({ environmentId: "env-2", type: "approval.requested" });

    expect(store.buildDelivery(webhook.webhookId, progress.eventId)).toBeUndefined();
    expect(store.buildDelivery(webhook.webhookId, approval.eventId)).toBeUndefined();
  });

  it("applies subscription type filters before the replay limit", () => {
    const store = makeStore();
    const subscription = store.subscribe({
      environmentId: "env-1",
      types: ["approval.requested"],
    });
    store.emit({ environmentId: "env-1", type: "thread.progress" });
    store.emit({ environmentId: "env-1", type: "thread.progress" });
    store.emit({ environmentId: "env-1", type: "approval.requested" });

    expect(store.pendingFor(subscription.subscriptionId, 1).map((event) => event.type)).toEqual([
      "approval.requested",
    ]);
  });

  it("rejects IPv4-mapped IPv6 private, loopback, and link-local destinations", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:172.16.0.1",
      "::ffff:192.168.1.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isPrivateWebhookAddress(address), address).toBe(true);
      expect(() =>
        makeStore().registerWebhook({
          environmentId: "env-1",
          url: `https://[${address}]/hook`,
        }),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    }
  });

  it("remembers and recalls request results exactly once", () => {
    const store = makeStore();
    expect(store.rememberRequest("key-1", '{"a":1}', { status: "accepted" })).toBe("accepted");
    expect(store.rememberRequest("key-1", '{"a":1}', { status: "accepted" })).toBe("duplicate");
    expect(store.recallRequest<{ status: string }>("key-1")).toEqual({ status: "accepted" });
    expect(store.rememberRequest("key-1", '{"a":2}', { status: "accepted" })).toBe("conflict");
    store.forgetRequest("key-1");
    expect(store.rememberRequest("key-1", '{"a":2}', { status: "accepted" })).toBe("accepted");
    expect(store.recallRequest("key-2")).toBeUndefined();
  });
});
