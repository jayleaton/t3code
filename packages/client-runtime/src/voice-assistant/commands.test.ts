import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bindAnswerToPendingRequest,
  createProposal,
  proposalIdempotencyKey,
  resolveDecisionFallback,
  resolveExactTarget,
  validateProposal,
  type PendingRequestTarget,
  type VoiceProposedCommand,
} from "./commands.ts";

const envId = "env-1" as EnvironmentId;
const threadId = "thread-1";

const pendingRequest = (overrides: Partial<PendingRequestTarget> = {}): PendingRequestTarget => ({
  environmentId: envId,
  threadId,
  requestId: "req-1",
  kind: "input",
  prompt: "Which database should I use?",
  options: ["postgres", "sqlite"],
  ...overrides,
});

describe("proposal idempotency", () => {
  it("reproduces the same key when the same proposal is retried", () => {
    const input = {
      kind: "send-message" as const,
      utteranceId: "utt-1",
      target: { environmentId: envId, threadId },
      payload: { text: "continue" },
      sequence: 0,
    };

    const first = createProposal(input);
    const retry = createProposal(input);

    expect(first.idempotencyKey).toBe(retry.idempotencyKey);
    expect(first.idempotencyKey).toBe(proposalIdempotencyKey(input));
  });

  it("changes the key when the target changes", () => {
    const base = {
      kind: "send-message" as const,
      utteranceId: "utt-1",
      sequence: 0,
    };
    const a = proposalIdempotencyKey({ ...base, target: { environmentId: envId, threadId } });
    const b = proposalIdempotencyKey({
      ...base,
      target: { environmentId: envId, threadId: "thread-2" },
    });

    expect(a).not.toBe(b);
  });
});

describe("resolveExactTarget", () => {
  const candidates = [
    { id: "t1", label: "Mobile layout" },
    { id: "t2", label: "Desktop polish" },
  ];

  it("resolves an exact label case-insensitively", () => {
    expect(resolveExactTarget("mobile layout", candidates)).toEqual({
      status: "resolved",
      value: candidates[0],
    });
  });

  it("resolves a unique partial label", () => {
    expect(resolveExactTarget("desktop", candidates)).toEqual({
      status: "resolved",
      value: candidates[1],
    });
  });

  it("reports ambiguity instead of guessing", () => {
    const ambiguous = [
      { id: "t1", label: "Mobile layout" },
      { id: "t3", label: "Mobile tests" },
    ];
    expect(resolveExactTarget("mobile", ambiguous).status).toBe("ambiguous");
  });

  it("reports none for an unknown target", () => {
    expect(resolveExactTarget("no such thread", candidates).status).toBe("none");
  });
});

describe("bindAnswerToPendingRequest", () => {
  it("binds yes to a single pending question presented to this user", () => {
    const result = bindAnswerToPendingRequest("yes", [pendingRequest()]);
    expect(result.status).toBe("bound");
    if (result.status === "bound") {
      expect(result.request.requestId).toBe("req-1");
    }
  });

  it("refuses to guess between two pending questions", () => {
    const result = bindAnswerToPendingRequest("yes", [
      pendingRequest({ requestId: "req-1" }),
      pendingRequest({ requestId: "req-2" }),
    ]);
    expect(result.status).toBe("ambiguous");
  });

  it("binds an ordinal to the matching question", () => {
    const result = bindAnswerToPendingRequest("the second one", [
      pendingRequest({ requestId: "req-1" }),
      pendingRequest({ requestId: "req-2", prompt: "Which region?" }),
    ]);
    expect(result.status).toBe("bound");
    if (result.status === "bound") {
      expect(result.request.requestId).toBe("req-2");
    }
  });

  it("binds a spoken option label", () => {
    const result = bindAnswerToPendingRequest("sqlite", [pendingRequest()]);
    expect(result.status).toBe("bound");
  });

  it("returns none when nothing is pending", () => {
    expect(bindAnswerToPendingRequest("yes", []).status).toBe("none");
  });
});

describe("validateProposal", () => {
  const base: VoiceProposedCommand = createProposal({
    kind: "send-message",
    utteranceId: "utt-1",
    target: { environmentId: envId, threadId },
    payload: { text: "continue" },
    sequence: 0,
  });

  it("accepts a proposal whose target still exists", () => {
    expect(
      validateProposal(base, {
        environmentIds: [envId],
        threadIdsByEnvironment: { [envId]: [threadId] },
        pendingRequestIds: [],
      }),
    ).toEqual({ status: "valid" });
  });

  it("rejects a stale thread target", () => {
    const result = validateProposal(base, {
      environmentIds: [envId],
      threadIdsByEnvironment: { [envId]: ["other-thread"] },
      pendingRequestIds: [],
    });
    expect(result.status).toBe("invalid");
  });

  it("rejects an input response whose request was already resolved", () => {
    const proposal = createProposal({
      kind: "respond-to-user-input",
      utteranceId: "utt-1",
      target: { environmentId: envId, threadId },
      payload: { answer: "sqlite" },
      requestId: "req-1",
      sequence: 0,
    });
    const result = validateProposal(proposal, {
      environmentIds: [envId],
      threadIdsByEnvironment: { [envId]: [threadId] },
      pendingRequestIds: [],
    });
    expect(result.status).toBe("invalid");
  });

  it("accepts an input response while the request is still pending", () => {
    const proposal = createProposal({
      kind: "respond-to-user-input",
      utteranceId: "utt-1",
      target: { environmentId: envId, threadId },
      payload: { answer: "sqlite" },
      requestId: "req-1",
      sequence: 0,
    });
    expect(
      validateProposal(proposal, {
        environmentIds: [envId],
        threadIdsByEnvironment: { [envId]: [threadId] },
        pendingRequestIds: ["req-1"],
      }),
    ).toEqual({ status: "valid" });
  });
});

describe("resolveDecisionFallback", () => {
  const candidates = [{ id: "t1", label: "Mobile layout" }];

  it("uses exact target selection when Jev is unavailable", () => {
    const result = resolveDecisionFallback({ status: "unavailable" }, () =>
      resolveExactTarget("Mobile layout", candidates),
    );
    expect(result.status).toBe("resolved");
  });

  it("asks the user to clarify when Jev abstains and no exact target matches", () => {
    const result = resolveDecisionFallback({ status: "abstained" }, () =>
      resolveExactTarget("something else", candidates),
    );
    expect(result.status).toBe("clarify");
  });
});
