import { describe, expect, it } from "vite-plus/test";

import {
  buildAnnouncement,
  notificationIdentity,
  notificationPriority,
  VoiceSpeechQueue,
  type VoiceNotification,
  type VoiceNotificationKind,
} from "./notifications.ts";

const notification = (
  overrides: Partial<VoiceNotification> & { readonly kind: VoiceNotificationKind },
): VoiceNotification => ({
  eventId: `event-${overrides.serverSequence ?? 1}`,
  environmentId: "env-1",
  threadId: "thread-1",
  threadLabel: "Mobile layout",
  turnId: "turn-1",
  requestId: null,
  serverSequence: 1,
  ...overrides,
});

const allOn = { completions: true, inputRequests: true, approvals: true };
const queue = () => new VoiceSpeechQueue({ preferences: allOn, maxQueue: 5 });

describe("voice notification identity and priority", () => {
  it("distinguishes two input requests in the same turn by request id", () => {
    const first = notification({
      kind: "input-needed",
      requestId: "req-1",
      eventId: "e1",
      serverSequence: 1,
    });
    const second = notification({
      kind: "input-needed",
      requestId: "req-2",
      eventId: "e2",
      serverSequence: 2,
    });
    expect(notificationIdentity(first)).not.toBe(notificationIdentity(second));
  });

  it("ranks input and approval above completions", () => {
    expect(notificationPriority("input-needed")).toBeGreaterThan(
      notificationPriority("completion"),
    );
    expect(notificationPriority("approval-needed")).toBeGreaterThan(
      notificationPriority("failure"),
    );
  });
});

describe("VoiceSpeechQueue", () => {
  it("does not announce events that existed before voice was enabled", () => {
    const speech = queue();
    speech.seed([notification({ kind: "completion", eventId: "old", serverSequence: 1 })]);

    expect(
      speech.enqueue(notification({ kind: "completion", eventId: "old", serverSequence: 1 })),
    ).toBe(false);
    expect(speech.next()).toBeNull();
  });

  it("dedupes repeated deliveries of the same event", () => {
    const speech = queue();
    const event = notification({ kind: "completion", eventId: "e1", serverSequence: 1 });

    expect(speech.enqueue(event)).toBe(true);
    expect(speech.enqueue(event)).toBe(false);
    expect(speech.size).toBe(1);
  });

  it("speaks a second input request in the same turn distinctly", () => {
    const speech = queue();
    speech.enqueue(
      notification({ kind: "input-needed", requestId: "req-1", eventId: "e1", serverSequence: 1 }),
    );
    speech.enqueue(
      notification({ kind: "input-needed", requestId: "req-2", eventId: "e2", serverSequence: 2 }),
    );

    expect(speech.size).toBe(2);
    expect(speech.next()).toBe("Mobile layout is asking for input.");
    expect(speech.next()).toBe("Mobile layout is asking for input.");
  });

  it("drops an obsolete question resolved on another client before speaking", () => {
    const speech = queue();
    speech.enqueue(
      notification({ kind: "input-needed", requestId: "req-1", eventId: "e1", serverSequence: 1 }),
    );
    speech.resolveRequest("req-1");

    expect(speech.size).toBe(0);
    expect(speech.next()).toBeNull();
  });

  it("prioritizes input over a completion regardless of arrival order", () => {
    const speech = queue();
    speech.enqueue(notification({ kind: "completion", eventId: "e1", serverSequence: 1 }));
    speech.enqueue(
      notification({ kind: "input-needed", requestId: "req-1", eventId: "e2", serverSequence: 2 }),
    );

    expect(speech.next()).toBe("Mobile layout is asking for input.");
    expect(speech.next()).toBe("Mobile layout finished its turn.");
  });

  it("coalesces a burst of completions into one summary", () => {
    const speech = queue();
    speech.enqueue(
      notification({
        kind: "completion",
        eventId: "e1",
        serverSequence: 1,
        threadId: "thread-a",
        turnId: "turn-a",
        threadLabel: "A",
      }),
    );
    speech.enqueue(
      notification({
        kind: "completion",
        eventId: "e2",
        serverSequence: 2,
        threadId: "thread-b",
        turnId: "turn-b",
        threadLabel: "B",
      }),
    );
    speech.enqueue(
      notification({
        kind: "completion",
        eventId: "e3",
        serverSequence: 3,
        threadId: "thread-c",
        turnId: "turn-c",
        threadLabel: "C",
      }),
    );

    expect(speech.next()).toBe("3 agents finished their turns.");
    expect(speech.next()).toBeNull();
  });

  it("bounds the queue and summarizes overflow", () => {
    const speech = new VoiceSpeechQueue({ preferences: allOn, maxQueue: 2 });
    for (let index = 0; index < 5; index += 1) {
      speech.enqueue(
        notification({
          kind: "input-needed",
          requestId: `req-${index}`,
          eventId: `e${index}`,
          serverSequence: index,
        }),
      );
    }

    expect(speech.size).toBe(2);
    expect(speech.next()).toBe("Mobile layout is asking for input.");
    expect(speech.next()).toBe("Mobile layout is asking for input.");
    expect(speech.next()).toBe("3 more agent updates are waiting.");
  });

  it("respects announcement preferences without losing event dedupe", () => {
    const speech = new VoiceSpeechQueue({
      preferences: { completions: false, inputRequests: true, approvals: false },
      maxQueue: 5,
    });
    speech.enqueue(notification({ kind: "completion", eventId: "e1", serverSequence: 1 }));
    speech.enqueue(
      notification({ kind: "input-needed", requestId: "req-1", eventId: "e2", serverSequence: 2 }),
    );

    expect(speech.size).toBe(1);
    expect(speech.next()).toBe("Mobile layout is asking for input.");
  });
});

describe("buildAnnouncement", () => {
  it("never claims success for a completed turn", () => {
    expect(buildAnnouncement(notification({ kind: "completion" }))).toBe(
      "Mobile layout finished its turn.",
    );
  });

  it("names the pending need distinctly", () => {
    expect(buildAnnouncement(notification({ kind: "approval-needed" }))).toBe(
      "Mobile layout needs approval to continue.",
    );
    expect(buildAnnouncement(notification({ kind: "input-needed" }))).toBe(
      "Mobile layout is asking for input.",
    );
  });
});
