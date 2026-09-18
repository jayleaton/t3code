import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The operations the voice model may propose. Deliberately narrow: it is not
 * the whole gateway surface. Anything absent must be reported as unsupported,
 * never simulated as success.
 */
export const VOICE_COMMAND_KINDS = [
  "list-environments",
  "list-projects",
  "list-agents",
  "list-threads",
  "summarize-thread",
  "read-thread",
  "create-and-start-thread",
  "send-message",
  "respond-to-user-input",
  "respond-to-approval",
  "stop-thread",
  "cancel-thread",
] as const;
export type VoiceCommandKind = (typeof VOICE_COMMAND_KINDS)[number];

export interface VoiceTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly profileId?: string;
}

/** A single mutable operation the model proposed for one finalized utterance. */
export interface VoiceProposedCommand {
  readonly kind: VoiceCommandKind;
  readonly utteranceId: string;
  readonly target: VoiceTarget;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * Stable across retries of the same proposal. Reusing it is what makes a
   * transport retry idempotent instead of creating a second thread/message.
   */
  readonly idempotencyKey: string;
  /** Only set for structured input/approval responses. */
  readonly requestId?: string;
}

export interface PendingRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly requestId: string;
  readonly kind: "input" | "approval";
  /** The human-readable question this request represents. */
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
}

export type BindAnswerResult =
  | { readonly status: "bound"; readonly request: PendingRequestTarget; readonly answer: string }
  | { readonly status: "ambiguous"; readonly candidates: ReadonlyArray<PendingRequestTarget> }
  | { readonly status: "none" };

/**
 * Binds a short affirmative/selection reply to the still-pending question that
 * was actually presented. It never guesses: more than one candidate is
 * ambiguous, and no candidate means the reply is not an answer to anything.
 */
export function bindAnswerToPendingRequest(
  transcript: string,
  pending: ReadonlyArray<PendingRequestTarget>,
): BindAnswerResult {
  if (pending.length === 0) {
    return { status: "none" };
  }
  const normalized = transcript.trim().toLowerCase();
  if (normalized.length === 0) {
    return { status: "none" };
  }

  const ordinalMatch = /\b(?:the\s+)?(first|second|third|1st|2nd|3rd)\b/.exec(normalized);
  if (ordinalMatch !== null && pending.length > 1) {
    const index = ORDINALS[ordinalMatch[1] ?? ""] ?? -1;
    const request = index >= 0 ? pending[index] : undefined;
    if (request === undefined) {
      return { status: "ambiguous", candidates: pending };
    }
    return { status: "bound", request, answer: transcript.trim() };
  }

  // "yes"/"approve" bind only when exactly one question is pending.
  if (isAffirmative(normalized) || isNegative(normalized)) {
    const only = pending.length === 1 ? pending[0] : undefined;
    if (only === undefined) {
      return { status: "ambiguous", candidates: pending };
    }
    return { status: "bound", request: only, answer: transcript.trim() };
  }

  // A spoken option label binds when it uniquely matches one request's options.
  const matches = pending.filter((request) =>
    request.options.some((option) => option.trim().toLowerCase() === normalized),
  );
  const matched = matches.length === 1 ? matches[0] : undefined;
  if (matched !== undefined) {
    return { status: "bound", request: matched, answer: transcript.trim() };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", candidates: matches };
  }
  return { status: "ambiguous", candidates: pending };
}

const ORDINALS: Readonly<Record<string, number>> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
};

export function isAffirmative(value: string): boolean {
  return ["yes", "yeah", "yep", "sure", "approve", "approved", "do it", "go ahead"].includes(value);
}

export function isNegative(value: string): boolean {
  return ["no", "nope", "decline", "don't", "do not", "cancel", "stop"].includes(value);
}

export interface Resolvable {
  readonly id: string;
  readonly label: string;
}

export type ResolveResult<T extends Resolvable> =
  | { readonly status: "resolved"; readonly value: T }
  | { readonly status: "ambiguous"; readonly candidates: ReadonlyArray<T> }
  | { readonly status: "none" };

/**
 * Exact (case-insensitive) target resolution with no fuzzy guessing. The model
 * never supplies an ID directly; it supplies the spoken label and we map it
 * against fresh state. A near-miss is ambiguous, not a best guess.
 */
export function resolveExactTarget<T extends Resolvable>(
  spoken: string,
  candidates: ReadonlyArray<T>,
): ResolveResult<T> {
  const normalized = spoken.trim().toLowerCase();
  if (normalized.length === 0) {
    return { status: "none" };
  }
  const exact = candidates.filter(
    (candidate) => candidate.label.trim().toLowerCase() === normalized,
  );
  const exactMatch = exact.length === 1 ? exact[0] : undefined;
  if (exactMatch !== undefined) {
    return { status: "resolved", value: exactMatch };
  }
  if (exact.length > 1) {
    return { status: "ambiguous", candidates: exact };
  }
  const contains = candidates.filter((candidate) =>
    candidate.label.trim().toLowerCase().includes(normalized),
  );
  const containsMatch = contains.length === 1 ? contains[0] : undefined;
  if (containsMatch !== undefined) {
    return { status: "resolved", value: containsMatch };
  }
  return contains.length === 0 ? { status: "none" } : { status: "ambiguous", candidates: contains };
}

export interface CreateProposalInput {
  readonly kind: VoiceCommandKind;
  readonly utteranceId: string;
  readonly target: VoiceTarget;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Monotonic index of this proposal within the utterance. */
  readonly sequence: number;
  readonly requestId?: string;
}

/**
 * Builds a proposal with a deterministic idempotency key. Retrying the same
 * proposal (same utterance, kind, target, sequence) reproduces the key, so the
 * server's command receipt dedupes it into one message/thread.
 */
export function createProposal(input: CreateProposalInput): VoiceProposedCommand {
  return {
    kind: input.kind,
    utteranceId: input.utteranceId,
    target: input.target,
    payload: input.payload,
    idempotencyKey: proposalIdempotencyKey(input),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
}

export function proposalIdempotencyKey(input: {
  readonly kind: VoiceCommandKind;
  readonly utteranceId: string;
  readonly target: VoiceTarget;
  readonly sequence: number;
}): string {
  const targetKey = [
    input.target.environmentId,
    input.target.projectId ?? "",
    input.target.threadId ?? "",
    input.target.profileId ?? "",
  ].join("~");
  return `voice:${input.utteranceId}:${input.kind}:${targetKey}:${input.sequence}`;
}

export interface VoiceValidationState {
  readonly environmentIds: ReadonlyArray<string>;
  readonly threadIdsByEnvironment: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly pendingRequestIds: ReadonlyArray<string>;
}

export type ProposalValidation =
  | { readonly status: "valid" }
  | { readonly status: "invalid"; readonly reason: string };

/**
 * Fresh-state validation. A selected ID that does not exist in the current
 * snapshot is rejected rather than executed against a stale target.
 */
export function validateProposal(
  proposal: VoiceProposedCommand,
  state: VoiceValidationState,
): ProposalValidation {
  if (!state.environmentIds.includes(proposal.target.environmentId)) {
    return { status: "invalid", reason: "The target environment is no longer available." };
  }
  if (proposal.target.threadId !== undefined) {
    const threads = state.threadIdsByEnvironment[proposal.target.environmentId] ?? [];
    if (!threads.includes(proposal.target.threadId)) {
      return { status: "invalid", reason: "The target thread no longer exists." };
    }
  }
  if (
    (proposal.kind === "respond-to-user-input" || proposal.kind === "respond-to-approval") &&
    proposal.requestId !== undefined &&
    !state.pendingRequestIds.includes(proposal.requestId)
  ) {
    return { status: "invalid", reason: "That request has already been resolved." };
  }
  return { status: "valid" };
}

/**
 * Jev is optional. When it is unavailable or low-certainty, exact target
 * selection and deterministic announcements still work; only a mutation that
 * truly needs a judgment falls back to asking the user.
 */
export function resolveDecisionFallback<T>(
  decision:
    | { readonly status: "decided"; readonly value: T }
    | {
        readonly status: "abstained";
      }
    | { readonly status: "unavailable" },
  exact: () => ResolveResult<T & Resolvable>,
):
  | { readonly status: "resolved"; readonly value: T & Resolvable }
  | { readonly status: "clarify" } {
  if (decision.status === "decided") {
    return { status: "resolved", value: decision.value as T & Resolvable };
  }
  const resolved = exact();
  return resolved.status === "resolved"
    ? { status: "resolved", value: resolved.value }
    : { status: "clarify" };
}

export function isVoiceMutation(kind: VoiceCommandKind): boolean {
  return (
    kind !== "list-environments" &&
    kind !== "list-projects" &&
    kind !== "list-agents" &&
    kind !== "list-threads" &&
    kind !== "read-thread" &&
    kind !== "summarize-thread"
  );
}
