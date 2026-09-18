export type VoiceNotificationKind = "completion" | "failure" | "approval-needed" | "input-needed";

/** Which agent events the user has asked to hear. */
export interface VoiceAnnouncementPreferences {
  readonly completions: boolean;
  readonly inputRequests: boolean;
  readonly approvals: boolean;
}

/**
 * A normalized agent event ready to speak. Identity fields are kept explicit so
 * dedupe can distinguish two input requests inside one turn (they differ by
 * requestId) while still collapsing repeated deliveries of the same event.
 */
export interface VoiceNotification {
  readonly eventId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadLabel: string;
  readonly turnId: string | null;
  readonly kind: VoiceNotificationKind;
  readonly requestId: string | null;
  readonly serverSequence: number;
}

/**
 * Identity for dedupe. A second question in the same turn must be announced, so
 * the requestId participates; a completion has no requestId and dedupes by turn.
 */
export function notificationIdentity(notification: VoiceNotification): string {
  return [
    notification.environmentId,
    notification.threadId,
    notification.turnId ?? "",
    notification.kind,
    notification.requestId ?? "",
  ].join(":");
}

/** Input and approval outrank completions and failures. */
export function notificationPriority(kind: VoiceNotificationKind): number {
  switch (kind) {
    case "input-needed":
    case "approval-needed":
      return 2;
    case "failure":
      return 1;
    case "completion":
      return 0;
  }
}

export function isAnnouncementEnabled(
  kind: VoiceNotificationKind,
  preferences: VoiceAnnouncementPreferences,
): boolean {
  switch (kind) {
    case "completion":
      return preferences.completions;
    case "failure":
      return preferences.completions;
    case "input-needed":
      return preferences.inputRequests;
    case "approval-needed":
      return preferences.approvals;
  }
}

/**
 * One deterministic sentence. Grounded only in the event's own fields, and
 * "finished its turn" never implies the requested outcome succeeded.
 */
export function buildAnnouncement(notification: VoiceNotification): string {
  const label = notification.threadLabel;
  switch (notification.kind) {
    case "completion":
      return `${label} finished its turn.`;
    case "failure":
      return `${label} hit an error.`;
    case "approval-needed":
      return `${label} needs approval to continue.`;
    case "input-needed":
      return `${label} is asking for input.`;
  }
}

export interface VoiceSpeechQueueOptions {
  readonly maxQueue?: number;
  readonly preferences: VoiceAnnouncementPreferences;
}

/**
 * Prioritizing, deduping speech queue. Resolved questions are dropped before
 * they are ever spoken, and a short burst of completions is summarized rather
 * than read out one by one.
 */
export class VoiceSpeechQueue {
  private readonly seenEventIds = new Set<string>();
  private readonly seenIdentities = new Set<string>();
  private readonly resolvedRequestIds = new Set<string>();
  private pending: VoiceNotification[] = [];
  private overflowCount = 0;
  private readonly maxQueue: number;
  private readonly preferences: VoiceAnnouncementPreferences;

  constructor(options: VoiceSpeechQueueOptions) {
    this.maxQueue = options.maxQueue ?? 5;
    this.preferences = options.preferences;
  }

  /**
   * Records the current state without queueing anything, so enabling voice does
   * not announce historical completions or already-open questions.
   */
  seed(notifications: ReadonlyArray<VoiceNotification>): void {
    for (const notification of notifications) {
      this.seenEventIds.add(notification.eventId);
      this.seenIdentities.add(notificationIdentity(notification));
    }
  }

  resolveRequest(requestId: string): void {
    this.resolvedRequestIds.add(requestId);
    this.pending = this.pending.filter((notification) => notification.requestId !== requestId);
  }

  enqueue(notification: VoiceNotification): boolean {
    if (notification.requestId !== null && this.resolvedRequestIds.has(notification.requestId)) {
      return false;
    }
    if (this.seenEventIds.has(notification.eventId)) {
      return false;
    }
    const identity = notificationIdentity(notification);
    if (this.seenIdentities.has(identity)) {
      return false;
    }
    this.seenEventIds.add(notification.eventId);
    this.seenIdentities.add(identity);
    if (!isAnnouncementEnabled(notification.kind, this.preferences)) {
      return false;
    }
    this.pending.push(notification);
    this.pending.sort(
      (left, right) =>
        notificationPriority(right.kind) - notificationPriority(left.kind) ||
        left.serverSequence - right.serverSequence,
    );
    if (this.pending.length > this.maxQueue) {
      const dropped = this.pending.splice(this.maxQueue);
      this.overflowCount += dropped.length;
    }
    return true;
  }

  get size(): number {
    return this.pending.length;
  }

  /**
   * Returns the next thing to speak, or null when the queue is empty. Several
   * pending completions collapse into one summary sentence.
   */
  next(): string | null {
    const first = this.pending[0];
    if (first === undefined) {
      if (this.overflowCount > 0) {
        const count = this.overflowCount;
        this.overflowCount = 0;
        return `${count} more agent updates are waiting.`;
      }
      return null;
    }
    if (first.kind === "completion") {
      const completions = this.pending.filter((entry) => entry.kind === "completion");
      this.pending = this.pending.filter((entry) => entry.kind !== "completion");
      if (completions.length > 1) {
        return `${completions.length} agents finished their turns.`;
      }
      return buildAnnouncement(first);
    }
    this.pending.shift();
    return buildAnnouncement(first);
  }

  clear(): void {
    this.pending = [];
    this.overflowCount = 0;
  }
}
