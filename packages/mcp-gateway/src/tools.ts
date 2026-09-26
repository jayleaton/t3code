import { skillFields } from "./skillInput.ts";
import { z } from "zod";
import * as NodeCrypto from "node:crypto";

import {
  GatewayError,
  GATEWAY_THREAD_EXECUTION_STATES,
  type GatewayApprovalDecision,
  type GatewayFocusTarget,
  type GatewayProfile,
  type GatewayRuntimePort,
  type GatewayScheduledTaskCreate,
  type GatewayScheduledTaskPatch,
  type GatewayScope,
  type GatewayThreadControlAction,
  type GatewayThreadExecutionState,
} from "./port.ts";
import type { GatewayEvent, GatewayEventStore } from "./events.ts";
import type { ScheduledTaskSchedule } from "@t3tools/contracts";

export type GatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type GatewayGrantSource = GatewayGrants | (() => GatewayGrants);
export type GatewayProfileSource =
  | ReadonlyArray<GatewayProfile>
  | (() => ReadonlyArray<GatewayProfile>);

export interface GatewayToolContext {
  readonly port: GatewayRuntimePort;
  readonly grants: GatewayGrantSource;
  readonly profiles?: GatewayProfileSource;
  readonly repositoryAllowlist?: ReadonlyArray<string>;
  readonly events?: GatewayEventStore;
  readonly health?: () => {
    readonly bridge: "connected" | "disconnected" | "degraded";
    readonly degradedReasons: ReadonlyArray<string>;
  };
}

/** The T3 chat whose agent made a relayed tool call, as stamped by its server. */
export interface GatewayCaller {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface GatewayInvocation {
  readonly caller?: GatewayCaller | undefined;
}

/** Reads the caller the environment server stamps into `_meta` of relayed tool calls. */
export function gatewayCaller(meta: unknown): GatewayCaller | undefined {
  const caller =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>)["t3code/caller"]
      : undefined;
  if (typeof caller !== "object" || caller === null) return undefined;
  const { environmentId, threadId } = caller as Record<string, unknown>;
  return typeof environmentId === "string" && typeof threadId === "string"
    ? { environmentId, threadId }
    : undefined;
}

export const handoffInputSchema = z.object({
  sourceEnvironmentId: z.string().min(1),
  sourceThreadId: z.string().min(1),
  environmentId: z.string().min(1),
  projectId: z.string().min(1),
  profileId: z.string().min(1),
  handoffId: z.string().uuid(),
  title: z.string().max(200),
  summary: z.string().trim().min(1).max(64000),
  prompt: z.string().trim().min(1).max(16000),
  files: z.array(z.string().min(1)).max(10).optional(),
});

const profileInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(280).optional(),
  providerLabel: z.string().trim().min(1),
  modelLabel: z.string().trim().min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  icon: z
    .enum(["orb", "bot", "code", "pen", "search", "shield", "sparkles", "terminal"])
    .optional(),
  skillIds: z.array(z.string().trim().min(1)).optional(),
  systemPrompt: z.string().max(32_000).optional(),
  reasoningEffort: z.string().trim().min(1).optional(),
  runtimeMode: z.enum([
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
    "read-only",
  ]),
  interactionMode: z.enum(["default", "plan"]),
  environmentIds: z.array(z.string().trim().min(1)).optional(),
});

const skillInput = z.object(skillFields);

async function shareSkills(context: GatewayToolContext, sourceId: string) {
  const failedEnvironmentIds: string[] = [];
  const grants = currentGrants(context.grants);
  for (const environment of await context.port.listEnvironments()) {
    const id = environment.environmentId;
    if (
      id === sourceId ||
      environment.connectionState !== "connected" ||
      !grants[id]?.some((scope) => scope === "create" || scope === "admin")
    )
      continue;
    try {
      if (!context.port.syncAgentLibrary) throw new Error("Skill sharing unavailable.");
      await context.port.syncAgentLibrary(id);
    } catch {
      failedEnvironmentIds.push(id);
    }
  }
  return { failedEnvironmentIds };
}

async function shareProfiles(
  context: GatewayToolContext,
  sourceId: string,
  deletedAt?: Readonly<Record<string, string>>,
) {
  const profiles = await authoritativeProfiles(context, sourceId);
  const environments = await context.port.listEnvironments();
  const failedEnvironmentIds: string[] = [];
  const grants = currentGrants(context.grants);
  for (const environment of environments) {
    const id = environment.environmentId;
    if (
      id === sourceId ||
      environment.connectionState !== "connected" ||
      !grants[id]?.some((scope) => scope === "create" || scope === "admin")
    )
      continue;
    try {
      if (!context.port.replicateProfiles) throw new Error("Profile sharing unavailable.");
      if (deletedAt) await context.port.replicateProfiles(id, profiles, deletedAt);
      else await context.port.replicateProfiles(id, profiles);
    } catch {
      failedEnvironmentIds.push(id);
    }
  }
  return { failedEnvironmentIds };
}

function currentGrants(source: GatewayGrantSource): GatewayGrants {
  return Object.assign(Object.create(null), typeof source === "function" ? source() : source);
}

async function authoritativeProfiles(
  context: GatewayToolContext,
  environmentId: string,
): Promise<ReadonlyArray<GatewayProfile>> {
  return context.port.listProfiles === undefined ? [] : context.port.listProfiles(environmentId);
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

function gatewayArtifactRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const artifact = record(value);
  const artifactId = typeof artifact.artifactId === "string" ? artifact.artifactId : undefined;
  const kind =
    artifact.kind === "attachment" || artifact.kind === "workspace-file"
      ? artifact.kind
      : undefined;
  const sourceId = typeof artifact.sourceId === "string" ? artifact.sourceId : undefined;
  const availability =
    artifact.availability === "available" ||
    artifact.availability === "unavailable" ||
    artifact.availability === "deleted"
      ? artifact.availability
      : undefined;
  if (
    artifactId === undefined ||
    kind === undefined ||
    sourceId === undefined ||
    availability === undefined
  ) {
    return undefined;
  }
  const path = typeof artifact.path === "string" ? artifact.path : undefined;
  if (
    path !== undefined &&
    (path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[a-z]:[\\/]/i.test(path) ||
      path.split(/[\\/]/).includes(".."))
  ) {
    return undefined;
  }
  return {
    artifactId,
    kind,
    sourceId,
    availability,
    ...(typeof artifact.name === "string" ? { name: artifact.name.slice(0, 512) } : {}),
    ...(path === undefined ? {} : { path }),
    ...(typeof artifact.mimeType === "string" ? { mimeType: artifact.mimeType.slice(0, 255) } : {}),
    ...(typeof artifact.sizeBytes === "number" ? { sizeBytes: artifact.sizeBytes } : {}),
    ...(typeof artifact.createdAt === "string" ? { createdAt: artifact.createdAt } : {}),
  };
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

function focusTargetFromInput(input: Record<string, unknown>): GatewayFocusTarget {
  const invalid = (message: string) =>
    new GatewayError({ code: "invalid_input", message, retryable: false });
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const line = typeof input.line === "number" ? input.line : undefined;
  if (input.view === "agents") {
    if (threadId !== "" || path !== "") throw invalid("view=agents takes no threadId or path.");
    return { type: "agents" };
  }
  if (threadId === "") throw invalid("threadId is required unless view=agents.");
  if (path !== "") return { type: "file", threadId, path, ...(line === undefined ? {} : { line }) };
  if (line !== undefined) throw invalid("line requires path.");
  return { type: "thread", threadId };
}

/** Builds a schedule from runAt or cron input; returns undefined when neither was given. */
function scheduleFromInput(input: Record<string, unknown>): ScheduledTaskSchedule | undefined {
  const invalid = (message: string) =>
    new GatewayError({ code: "invalid_input", message, retryable: false });
  const runAt = typeof input.runAt === "string" ? input.runAt : undefined;
  const cron = typeof input.cron === "string" ? input.cron : undefined;
  if (runAt !== undefined && cron !== undefined) throw invalid("Pass runAt or cron, not both.");
  if (runAt !== undefined) {
    if (input.timezone !== undefined) throw invalid("timezone applies to cron only.");
    return { kind: "once", runAt };
  }
  if (cron !== undefined) {
    const timezone =
      typeof input.timezone === "string"
        ? input.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { kind: "cron", expression: cron, timezone };
  }
  if (input.timezone !== undefined) throw invalid("timezone requires cron.");
  return undefined;
}

/** Tool input minus routing fields, with runAt/cron/timezone folded into a schedule. */
function scheduledTaskFields(input: Record<string, unknown>): Record<string, unknown> {
  const {
    environmentId: _environmentId,
    runAt: _runAt,
    cron: _cron,
    timezone: _timezone,
    ...rest
  } = input;
  const schedule = scheduleFromInput(input);
  return { ...rest, ...(schedule === undefined ? {} : { schedule }) };
}

function environmentWithScopes(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  requiredScopes: ReadonlyArray<GatewayScope>,
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
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new GatewayError({
      code: "scope_required",
      message: `Scope ${missingScopes.join(" and ")} is required for environment ${environmentId}.`,
      retryable: false,
      environmentId,
      details: { requiredScopes, missingScopes, grantedScopes: scopes },
    });
  }
  return environmentId;
}

function environmentWithScope(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  scope: GatewayScope,
): string {
  return environmentWithScopes(context, input, [scope]);
}

function environmentWithAnyScope(
  context: GatewayToolContext,
  input: Record<string, unknown>,
  acceptedScopes: ReadonlyArray<GatewayScope>,
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
  if (!acceptedScopes.some((scope) => scopes.includes(scope))) {
    throw new GatewayError({
      code: "scope_required",
      message: `One of scopes ${acceptedScopes.join(" or ")} is required for environment ${environmentId}. The owner can enable Control active work for this machine in Settings → MCP Gateway and save. Default read/create/send access does not include thread control. No control command was dispatched.`,
      retryable: false,
      environmentId,
      details: {
        requiredScopes: acceptedScopes,
        scopeRequirement: "any",
        missingScopes: acceptedScopes,
        grantedScopes: scopes,
      },
    });
  }
  return environmentId;
}

function idFor(kind: string, idempotencyKey: string): string {
  return `mcp-${kind}-${idempotencyKey}`;
}

function scopedIdFor(
  kind: string,
  environmentId: string,
  aggregateId: string,
  idempotencyKey: string,
): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(stablePayload({ version: 2, environmentId, aggregateId, idempotencyKey }))
    .digest("hex");
  return `mcp-${kind}-v2-${digest}`;
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

const EXECUTION_STATE_SET = new Set<string>(GATEWAY_THREAD_EXECUTION_STATES);

function readThreadExecutionState(
  thread: Record<string, unknown>,
): GatewayThreadExecutionState | undefined {
  const status = thread.status;
  return typeof status === "string" && EXECUTION_STATE_SET.has(status)
    ? (status as GatewayThreadExecutionState)
    : undefined;
}

function parseExecutionStateFilter(
  input: Record<string, unknown>,
): GatewayThreadExecutionState | undefined {
  const value = input.executionState;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !EXECUTION_STATE_SET.has(value)) {
    throw new GatewayError({
      code: "invalid_input",
      message: `executionState must be one of: ${GATEWAY_THREAD_EXECUTION_STATES.join(", ")}.`,
      retryable: false,
      details: { allowedExecutionStates: GATEWAY_THREAD_EXECUTION_STATES },
    });
  }
  return value as GatewayThreadExecutionState;
}

async function findGatewayThread(
  context: GatewayToolContext,
  environmentId: string,
  threadId: string,
): Promise<Record<string, unknown> | undefined> {
  const page = await context.port.listThreads(environmentId);
  return page.items.find(
    (candidate) => typeof candidate.id === "string" && candidate.id === threadId,
  );
}

/** Status hinted by a runtime event; undefined when the event carries no state. */
function gatewayEventExecutionState(event: GatewayEvent): GatewayThreadExecutionState | undefined {
  const status = event.data.status;
  if (typeof status === "string" && EXECUTION_STATE_SET.has(status)) {
    return status as GatewayThreadExecutionState;
  }
  switch (event.type) {
    case "thread.started":
      return "running";
    case "thread.completed":
      return "completed";
    case "thread.failed":
      return "failed";
    case "thread.interrupted":
      return "interrupted";
    case "approval.requested":
      return "waiting-approval";
    case "input.requested":
      return "waiting-input";
    default:
      return undefined;
  }
}

function boundedTimeoutMs(value: unknown, fallback: number): number {
  const requested = typeof value === "number" ? Math.trunc(value) : fallback;
  if (!Number.isFinite(requested)) return fallback;
  return Math.max(250, Math.min(120_000, requested));
}

function parseUntilStatuses(
  value: unknown,
): ReadonlyArray<GatewayThreadExecutionState> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new GatewayError({
      code: "invalid_input",
      message: "untilStatuses must be a non-empty array of execution states.",
      retryable: false,
    });
  }
  const parsed: GatewayThreadExecutionState[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !EXECUTION_STATE_SET.has(candidate)) {
      throw new GatewayError({
        code: "invalid_input",
        message: `untilStatuses must only contain: ${GATEWAY_THREAD_EXECUTION_STATES.join(", ")}.`,
        retryable: false,
        details: { allowedExecutionStates: GATEWAY_THREAD_EXECUTION_STATES },
      });
    }
    parsed.push(candidate as GatewayThreadExecutionState);
  }
  return parsed;
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

function isStaleApprovalFailure(payload: Record<string, unknown>): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

type PendingQuestion = {
  readonly questionId: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly allowsFreeText: boolean;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly value?: string;
  }>;
};
type PendingQuestionRequest = {
  readonly questionRequestId: string;
  readonly askedAt: string;
  readonly questions: ReadonlyArray<PendingQuestion>;
};

/** Questions the runtime projected onto a thread; empty for runtimes that predate them. */
function pendingQuestionsOf(
  thread: Record<string, unknown>,
): ReadonlyArray<PendingQuestionRequest> {
  return Array.isArray(thread.pendingQuestions)
    ? (thread.pendingQuestions as ReadonlyArray<PendingQuestionRequest>)
    : [];
}

type QuestionAnswerInput = {
  readonly questionId?: string | undefined;
  readonly options?: ReadonlyArray<string> | undefined;
  readonly text?: string | undefined;
};

function invalidAnswer(message: string, request: PendingQuestionRequest): GatewayError {
  return new GatewayError({
    code: "invalid_input",
    message,
    retryable: false,
    details: { questionRequestId: request.questionRequestId, questions: request.questions },
  });
}

/**
 * Turns chosen option labels or free text into the answers a provider expects:
 * each question id maps to its option value (the label when there is none),
 * a list of values for multi-select, or the text. Mirrors the composer's rules.
 */
export function resolveQuestionAnswers(
  request: PendingQuestionRequest,
  answers: ReadonlyArray<QuestionAnswerInput>,
): Record<string, string | ReadonlyArray<string>> {
  const resolved = new Map<string, string | ReadonlyArray<string>>();
  for (const answer of answers) {
    const question =
      answer.questionId === undefined
        ? request.questions.length === 1
          ? request.questions[0]
          : undefined
        : request.questions.find((candidate) => candidate.questionId === answer.questionId);
    if (question === undefined) {
      throw invalidAnswer(
        answer.questionId === undefined
          ? `This request asks ${request.questions.length} questions; pass questionId with each answer.`
          : `Question ${answer.questionId} is not part of this request.`,
        request,
      );
    }
    if (resolved.has(question.questionId)) {
      throw invalidAnswer(`"${question.header}" was answered more than once.`, request);
    }
    const text = answer.text?.trim() ?? "";
    const choices = answer.options ?? [];
    if (text !== "" && choices.length > 0) {
      throw invalidAnswer(
        `Answer "${question.header}" with options or with text, not both.`,
        request,
      );
    }
    if (text !== "") {
      if (!question.allowsFreeText) {
        throw invalidAnswer(`"${question.header}" only accepts one of its options.`, request);
      }
      resolved.set(question.questionId, text);
      continue;
    }
    if (choices.length === 0) {
      throw invalidAnswer(`Pass options or text for "${question.header}".`, request);
    }
    const values = [
      ...new Set(
        choices.map((choice) => {
          const wanted = choice.trim().toLocaleLowerCase();
          const option =
            question.options.find((candidate) => (candidate.value ?? candidate.label) === choice) ??
            question.options.find(
              (candidate) =>
                candidate.label.trim().toLocaleLowerCase() === wanted ||
                candidate.value?.trim().toLocaleLowerCase() === wanted,
            );
          if (option === undefined) {
            throw invalidAnswer(
              `"${choice}" is not an option for "${question.header}". Options: ${question.options.map((candidate) => candidate.label).join(", ")}.`,
              request,
            );
          }
          return option.value ?? option.label;
        }),
      ),
    ];
    if (!question.multiSelect && values.length !== 1) {
      throw invalidAnswer(`"${question.header}" takes exactly one option.`, request);
    }
    resolved.set(question.questionId, question.multiSelect ? values : values[0]!);
  }
  const missing = request.questions.filter((question) => !resolved.has(question.questionId));
  if (missing.length > 0) {
    throw invalidAnswer(
      `Answer every question in the request. Missing: ${missing.map((question) => question.header).join(", ")}.`,
      request,
    );
  }
  return Object.fromEntries(resolved);
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
        modifiableFields: ["decision"],
      });
    } else if (activity.kind === "approval.resolved") {
      pending.delete(requestId);
    } else if (
      activity.kind === "provider.approval.respond.failed" &&
      isStaleApprovalFailure(payload)
    ) {
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

function assertRepositoryAllowed(
  context: GatewayToolContext,
  environmentId: string,
  owner: string,
  repository: string,
): void {
  const identity = `${owner}/${repository}`.toLowerCase();
  const allowlist = context.repositoryAllowlist ?? ["jayleaton/t3code"];
  if (!allowlist.some((candidate) => candidate.toLowerCase() === identity)) {
    throw new GatewayError({
      code: "scope_required",
      message: `Repository ${identity} is outside the configured write allowlist.`,
      retryable: false,
      environmentId,
      details: { repository: identity, permission: "repository-allowlist" },
    });
  }
}

async function assertProjectRepositoryAllowed(
  context: GatewayToolContext,
  environmentId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const projectId = requiredString(input, "projectId");
  const projects = await context.port.listProjects(environmentId);
  const project = projects.items.find((candidate) => candidate.id === projectId);
  const identity =
    typeof project?.repositoryIdentity === "object" && project.repositoryIdentity !== null
      ? (project.repositoryIdentity as Record<string, unknown>)
      : undefined;
  if (typeof identity?.owner !== "string" || typeof identity.name !== "string") {
    throw new GatewayError({
      code: "invalid_input",
      message: `Project ${projectId} has no authoritative repository identity.`,
      retryable: false,
      environmentId,
    });
  }
  const requestedOwner = typeof input.owner === "string" ? input.owner : identity.owner;
  const rawRepository = typeof input.repository === "string" ? input.repository : identity.name;
  const requestedRepository = rawRepository.includes("/")
    ? (rawRepository.split("/", 2)[1] ?? "")
    : rawRepository;
  const qualifiedOwner = rawRepository.includes("/")
    ? (rawRepository.split("/", 2)[0] ?? "")
    : requestedOwner;
  if (
    qualifiedOwner !== identity.owner ||
    requestedRepository !== identity.name ||
    requestedOwner !== identity.owner
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Repository target does not match the selected project identity.",
      retryable: false,
      environmentId,
    });
  }
  assertRepositoryAllowed(context, environmentId, identity.owner, identity.name);
}

function requiredIdempotencyKey(input: Record<string, unknown>): string {
  return requiredString(input, "idempotencyKey");
}

function idempotencyCommandPayload(operation: string, input: Record<string, unknown>) {
  return { operation, input };
}

const pendingRequests = new WeakMap<GatewayEventStore, Map<string, Promise<unknown>>>();

// Memoizes a mutating command per (environmentId, threadId, requestId). On a
// first attempt it runs the operation and stores the receipt; a same-payload
// retry replays the stored receipt; a different payload is idempotency_conflict.
async function withIdempotency<Prepared = undefined>(
  context: GatewayToolContext,
  key: string,
  payload: unknown,
  operation: (prepared: Prepared | undefined) => Promise<unknown>,
  prepare?: () => Promise<Prepared> | Prepared,
): Promise<unknown> {
  // Additive v3 behavior: without an event store the command runs directly,
  // preserving the v1 single-shot semantics.
  if (context.events === undefined) {
    const prepared = prepare === undefined ? undefined : await prepare();
    return operation(prepared);
  }
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
  }
  const recovering = outcome === "duplicate" && events.requestState(key) === "dispatched";
  // Start on the next microtask so the Promise is visible to same-process
  // duplicates before validation or dispatch can yield.
  const execution = Promise.resolve().then(async () => {
    let prepared: Prepared | undefined;
    if (recovering) {
      prepared = events.recallDispatchContext<Prepared>(key);
    } else {
      try {
        prepared = prepare === undefined ? undefined : await prepare();
      } catch (error) {
        // A failed pre-dispatch check must not leave an ambiguous null receipt
        // that a later retry could mistake for an authoritative dispatch.
        events.forgetRequest(key);
        throw error;
      }
      events.markRequestDispatched(key, prepared);
    }
    const result = await operation(prepared);
    events.completeRequest(key, result);
    return result;
  });
  pending.set(key, execution);
  try {
    return await execution;
  } finally {
    pending.delete(key);
  }
}

async function assertRecoverableHistoricalSend(
  context: GatewayToolContext,
  key: string,
  environmentId: string,
  threadId: string,
  currentRequestId: string,
  historicalRequestIds: ReadonlyArray<string>,
): Promise<void> {
  const events = context.events;
  if (events === undefined) return;
  const state = events.requestState(key);
  if (state !== "dispatched" && state !== "completed") return;
  const stored =
    state === "completed"
      ? events.recallRequest<Record<string, unknown>>(key)
      : events.recallDispatchContext<Record<string, unknown>>(key);
  const requestId =
    typeof stored?.requestId === "string"
      ? stored.requestId
      : typeof stored?.commandId === "string"
        ? stored.commandId
        : undefined;
  if (requestId === currentRequestId) return;
  if (requestId === undefined || !historicalRequestIds.includes(requestId)) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message: "This send has no recoverable authoritative command identity.",
      retryable: false,
      environmentId,
      requestId: currentRequestId,
      details: { threadId },
    });
  }
  const messageId = typeof stored?.messageId === "string" ? stored.messageId : undefined;
  if (messageId === undefined || context.port.hasThreadMessage === undefined) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message:
        "This historical send receipt cannot be verified until the connected runtime supports authoritative message lookup.",
      retryable: false,
      environmentId,
      requestId,
      details: { threadId, messageId },
    });
  }
  const messageExists = await context.port.hasThreadMessage(environmentId, threadId, messageId);
  if (!messageExists) {
    throw new GatewayError({
      code: "idempotency_conflict",
      message:
        "This historical send receipt cannot be proven to have created its message; refusing an ambiguous replay.",
      retryable: false,
      environmentId,
      requestId,
      details: { threadId, messageId },
    });
  }
}

function requireOperationPort(context: GatewayToolContext) {
  if (context.port.executeOperation === undefined) {
    throw new GatewayError({
      code: "not_configured",
      message: "The connected runtime does not support this v3 operation.",
      retryable: false,
    });
  }
  return context.port.executeOperation.bind(context.port);
}

function assertPatchPathsAreProjectRelative(patch: string) {
  const paths = patch
    .split("\n")
    .filter((line) => line.startsWith("--- ") || line.startsWith("+++ "))
    .map((line) => line.slice(4).split("\t", 1)[0] ?? "")
    .filter((path) => path !== "/dev/null")
    .map((path) => (path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path));
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        path === "" || path.startsWith("/") || path.split("/").some((segment) => segment === ".."),
    )
  ) {
    throw new GatewayError({
      code: "invalid_input",
      message: "Patch paths must remain inside the selected project root.",
      retryable: false,
    });
  }
}

export async function callGatewayTool(
  context: GatewayToolContext,
  name: string,
  rawInput: unknown,
  invocation: GatewayInvocation = {},
): Promise<any> {
  const input = record(rawInput);
  switch (name) {
    case "t3_list_environments": {
      const environments = await context.port.listEnvironments();
      const grants = currentGrants(context.grants);
      return {
        items: environments
          .filter((environment) => grants[environment.environmentId] !== undefined)
          .map((environment) => ({
            ...environment,
            grantedScopes: grants[environment.environmentId],
          })),
        snapshotAt: "runtime",
      };
    }
    case "t3_get_environment_status": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getEnvironmentStatus(environmentId);
    }
    case "t3_get_environment_health": {
      const environmentId = environmentWithScope(context, input, "read");
      const status = await context.port.getEnvironmentStatus(environmentId);
      const phase = typeof status.phase === "string" ? status.phase : status.connectionState;
      return {
        environmentId,
        phase,
        health:
          phase === "connected"
            ? "healthy"
            : phase === "connecting"
              ? "connecting"
              : "disconnected",
        providerRuntimeReady: phase === "connected",
        eventStreamReady: context.events !== undefined && phase === "connected",
        artifactStoreReady: phase === "connected",
        degradedReasons:
          phase === "connected" ? [] : [String(status.lastFailure ?? phase ?? "unavailable")],
        snapshotAt: "runtime",
      };
    }
    case "t3_get_gateway_health": {
      const grants = currentGrants(context.grants);
      const runtimeHealth = context.health?.() ?? {
        bridge: "connected" as const,
        degradedReasons: [] as ReadonlyArray<string>,
      };
      const deliveryFailures = context.events?.deliveryFailureSummary(Object.keys(grants)) ?? {
        count: 0,
        recent: [],
      };
      const health =
        runtimeHealth.bridge === "connected" && deliveryFailures.count === 0
          ? "healthy"
          : "degraded";
      return {
        health,
        mcpTransport: "connected",
        bridge: runtimeHealth.bridge,
        eventStore:
          context.events === undefined
            ? "not-configured"
            : deliveryFailures.count === 0
              ? "ready"
              : "degraded",
        environmentCount: Object.keys(grants).length,
        latestSequenceByEnvironment:
          context.events === undefined
            ? {}
            : Object.fromEntries(
                Object.keys(grants).map((id) => [id, context.events?.latestSequence(id) ?? 0]),
              ),
        deliveryFailureCount: deliveryFailures.count,
        degradedReasons: [
          ...runtimeHealth.degradedReasons,
          ...deliveryFailures.recent.map(
            (failure) =>
              `Webhook ${failure.webhookId} failed after ${failure.attempts} attempts: ${failure.error.slice(0, 500)}`,
          ),
        ],
        clock: "runtime",
      };
    }
    case "t3_handoff_thread": {
      const parsed = handoffInputSchema.parse(input);
      environmentWithScopes(context, parsed, ["create", "send", "artifact"]);
      environmentWithScopes(
        context,
        { environmentId: parsed.sourceEnvironmentId },
        parsed.files?.length ? ["read", "artifact"] : ["read"],
      );
      if (!context.port.handoffThread)
        throw new Error("Agent handoff is unavailable in this runtime.");
      return context.port.handoffThread(parsed);
    }
    case "t3_settle_thread": {
      const environmentId = environmentWithScope(context, input, "lifecycle");
      if (input.confirmed !== true)
        throw new Error("Ask the user before settling the source conversation.");
      if (!context.port.settleThread)
        throw new Error("Thread settlement is unavailable in this runtime.");
      return context.port.settleThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_unsettle_thread": {
      const environmentId = environmentWithScope(context, input, "lifecycle");
      if (!context.port.unsettleThread)
        throw new Error("Thread un-settlement is unavailable in this runtime.");
      return context.port.unsettleThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_set_thread_parent": {
      const environmentId = environmentWithScope(context, input, "lifecycle");
      if (!context.port.setThreadParent)
        throw new Error("Linking chats is unavailable in this runtime.");
      const parentThreadId =
        input.parentThreadId === null ? null : requiredString(input, "parentThreadId");
      return context.port.setThreadParent(
        environmentId,
        requiredString(input, "threadId"),
        parentThreadId,
      );
    }
    case "t3_list_skills": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.listSkills)
        throw new Error("Shared skills are unavailable in this runtime. Update T3.");
      return { items: await context.port.listSkills(environmentId) };
    }
    case "t3_create_skill":
    case "t3_update_skill": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      const parsed = (
        name === "t3_create_skill" ? skillInput : skillInput.partial().strict()
      ).safeParse(name === "t3_create_skill" ? input : input.patch);
      if (!parsed.success)
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.message,
          retryable: false,
        });
      let skill;
      if (name === "t3_create_skill") {
        if (!context.port.createSkill)
          throw new Error("Shared skills are unavailable in this runtime. Update T3.");
        skill = await context.port.createSkill(environmentId, skillInput.parse(parsed.data));
      } else {
        if (!context.port.updateSkill)
          throw new Error("Shared skills are unavailable in this runtime. Update T3.");
        skill = await context.port.updateSkill(
          environmentId,
          requiredString(input, "skillId"),
          parsed.data,
        );
      }
      return { skill, sync: await shareSkills(context, environmentId) };
    }
    case "t3_delete_skill": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.deleteSkill)
        throw new Error("Shared skills are unavailable in this runtime. Update T3.");
      const result = await context.port.deleteSkill(
        environmentId,
        requiredString(input, "skillId"),
      );
      return { ...result, sync: await shareSkills(context, environmentId) };
    }
    case "t3_create_agent": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.createProfile)
        throw new Error("Profile creation is unavailable in this runtime.");
      const parsed = profileInput.safeParse(input);
      if (!parsed.success)
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.message,
          retryable: false,
        });
      const profile = await context.port.createProfile(environmentId, parsed.data);
      return { profile, sync: await shareProfiles(context, environmentId) };
    }
    case "t3_update_agent": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.updateProfile)
        throw new Error("Profile editing is unavailable in this runtime.");
      const parsed = profileInput.partial().strict().safeParse(input.patch);
      if (!parsed.success)
        throw new GatewayError({
          code: "invalid_input",
          message: parsed.error.message,
          retryable: false,
        });
      const profile = await context.port.updateProfile(
        environmentId,
        requiredString(input, "profileId"),
        parsed.data,
      );
      return { profile, sync: await shareProfiles(context, environmentId) };
    }
    case "t3_delete_agent": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.deleteProfile)
        throw new Error("Profile deletion is unavailable in this runtime.");
      const result = await context.port.deleteProfile(
        environmentId,
        requiredString(input, "profileId"),
      );
      return {
        ...result,
        sync: await shareProfiles(
          context,
          environmentId,
          result.deletedAt ? { [result.profileId]: result.deletedAt } : undefined,
        ),
      };
    }
    case "t3_open_agents": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.openAgents) throw new Error("Desktop agents navigation is unavailable.");
      return context.port.openAgents(environmentId);
    }
    case "t3_list_projects": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.listProjects(environmentId);
    }
    case "t3_list_threads": {
      const environmentId = environmentWithScope(context, input, "read");
      const state = z.enum(["all", "active", "settled"]).default("all").parse(input.state);
      const executionState = parseExecutionStateFilter(input);
      const page = await context.port.listThreads(environmentId);
      const projectId = typeof input.projectId === "string" ? input.projectId : undefined;
      const profileId = typeof input.profileId === "string" ? input.profileId : undefined;
      const parentThreadId =
        typeof input.parentThreadId === "string" ? input.parentThreadId : undefined;
      const items = page.items.filter((thread) => {
        const snapshot = thread.profileSnapshot as { profileId?: string } | undefined;
        return (
          (projectId === undefined || thread.projectId === projectId) &&
          (parentThreadId === undefined || thread.parentThreadId === parentThreadId) &&
          (profileId === undefined || snapshot?.profileId === profileId) &&
          (state === "all" ||
            (state === "settled" ? thread.settledAt != null : thread.settledAt == null)) &&
          (executionState === undefined || readThreadExecutionState(thread) === executionState)
        );
      });
      if (input.includeQuestions !== true) return { ...page, items };
      // Only chats waiting on a question need a detail read; the rest pass through.
      return {
        ...page,
        items: await Promise.all(
          items.map(async (thread) =>
            thread.hasPendingUserInput === true && typeof thread.id === "string"
              ? {
                  ...thread,
                  pendingQuestions: pendingQuestionsOf(
                    await context.port.getThread(environmentId, thread.id),
                  ),
                }
              : thread,
          ),
        ),
      };
    }
    case "t3_list_devices": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.listDevices)
        throw new Error("Device focus is unavailable in this runtime. Update T3.");
      return { items: await context.port.listDevices(environmentId) };
    }
    case "t3_focus_device": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.focusDevice)
        throw new Error("Device focus is unavailable in this runtime. Update T3.");
      return context.port.focusDevice(
        environmentId,
        requiredString(input, "device"),
        focusTargetFromInput(input),
      );
    }
    case "t3_list_scheduled_tasks": {
      const environmentId = environmentWithScope(context, input, "read");
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      return context.port.scheduledTask(environmentId, { action: "list" });
    }
    case "t3_create_scheduled_task": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      const fields = scheduledTaskFields(input);
      if (!("schedule" in fields)) {
        throw new GatewayError({
          code: "invalid_input",
          message: "Pass runAt for a one-time task or cron for a recurring one.",
          retryable: false,
        });
      }
      return context.port.scheduledTask(environmentId, {
        action: "create",
        input: fields as GatewayScheduledTaskCreate,
      });
    }
    case "t3_update_scheduled_task": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      const patch =
        typeof input.patch === "object" && input.patch !== null
          ? (input.patch as Record<string, unknown>)
          : {};
      return context.port.scheduledTask(environmentId, {
        action: "update",
        taskId: requiredString(input, "taskId"),
        patch: scheduledTaskFields(patch) as GatewayScheduledTaskPatch,
      });
    }
    case "t3_delete_scheduled_task": {
      const environmentId = environmentWithAnyScope(context, input, ["create", "admin"]);
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      return context.port.scheduledTask(environmentId, {
        action: "delete",
        taskId: requiredString(input, "taskId"),
      });
    }
    case "t3_run_scheduled_task": {
      const environmentId = environmentWithScope(context, input, "send");
      if (!context.port.scheduledTask)
        throw new Error("Scheduled tasks are unavailable in this runtime. Update T3.");
      return context.port.scheduledTask(environmentId, {
        action: "run",
        taskId: requiredString(input, "taskId"),
      });
    }
    case "t3_open_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.openThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_get_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      return context.port.getThread(environmentId, requiredString(input, "threadId"));
    }
    case "t3_summarize_thread": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const plan = approvalPlan(thread);
      const pendingQuestions = pendingQuestionsOf(thread);
      const session =
        typeof thread.session === "object" && thread.session !== null
          ? (thread.session as Record<string, unknown>)
          : null;
      const latestTurn =
        typeof thread.latestTurn === "object" && thread.latestTurn !== null
          ? (thread.latestTurn as Record<string, unknown>)
          : null;
      const status =
        thread.settledAt != null
          ? "settled"
          : plan.actions.length > 0
            ? "waiting-approval"
            : pendingQuestions.length > 0
              ? "waiting-input"
              : typeof thread.status === "string"
                ? thread.status
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
        pendingQuestions,
        artifacts: Array.isArray(thread.artifacts) ? thread.artifacts : [],
        nextAction:
          plan.actions.length > 0
            ? "approve_actions"
            : pendingQuestions.length > 0
              ? "provide_input"
              : status === "running" || status === "queued"
                ? "await_event"
                : null,
        snapshotAt: thread.updatedAt ?? "runtime",
      };
    }
    case "t3_get_agents_view": {
      const environmentId = environmentWithScope(context, input, "read");
      const { profileId, state } = z
        .object({
          profileId: z.string().trim().min(1).optional(),
          state: z.enum(["active", "settled", "all"]).default("active"),
        })
        .parse(input);
      const executionState = parseExecutionStateFilter(input);
      const [profiles, page] = await Promise.all([
        authoritativeProfiles(context, environmentId),
        context.port.listThreads(environmentId),
      ]);
      const runsByProfile = new Map<string, Record<string, unknown>[]>();
      for (const thread of page.items) {
        const snapshot = thread.profileSnapshot as { profileId?: string } | null | undefined;
        const agentId = snapshot?.profileId;
        if (!agentId || (profileId !== undefined && profileId !== agentId)) continue;
        if (
          state !== "all" &&
          (state === "settled" ? thread.settledAt == null : thread.settledAt != null)
        )
          continue;
        if (executionState !== undefined && readThreadExecutionState(thread) !== executionState)
          continue;
        const runs = runsByProfile.get(agentId) ?? [];
        runs.push({
          threadId: thread.id,
          environmentId,
          projectId: thread.projectId,
          title: thread.title,
          status: thread.status,
          settledAt: thread.settledAt ?? null,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
        runsByProfile.set(agentId, runs);
      }
      const items = profiles
        .filter((profile) => profileId === undefined || profile.profileId === profileId)
        .map((profile) => {
          const runs = profile.profileId ? (runsByProfile.get(profile.profileId) ?? []) : [];
          if (profile.profileId) runsByProfile.delete(profile.profileId);
          return {
            profileId: profile.profileId,
            name: profile.name,
            description: profile.description ?? "",
            providerLabel: profile.providerLabel,
            modelLabel: profile.modelLabel,
            environmentIds: profile.environmentIds ?? [],
            runs,
          };
        });
      return {
        environmentId,
        items,
        orphanedRuns: [...runsByProfile].flatMap(([profileId, runs]) =>
          runs.map((run) => ({ ...run, profileId })),
        ),
        snapshotAt: page.snapshotAt,
      };
    }
    case "t3_list_agents": {
      const environmentId = environmentWithScope(context, input, "read");
      return {
        items: (await authoritativeProfiles(context, environmentId)).filter(
          (profile) =>
            !Array.isArray(profile.environmentIds) ||
            profile.environmentIds.length === 0 ||
            profile.environmentIds.includes(environmentId),
        ),
        snapshotAt: "runtime",
      };
    }
    case "t3_get_approval_plan": {
      const environmentId = environmentWithScope(context, input, "approval");
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
    case "t3_get_operation_history": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const afterSequence =
        typeof input.afterSequence === "number" ? Math.max(0, Math.trunc(input.afterSequence)) : 0;
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 200;
      const items = events.operationHistory(
        environmentId,
        afterSequence,
        limit,
        typeof input.threadId === "string" ? input.threadId : undefined,
      );
      return {
        items,
        ...(items.at(-1) === undefined ? {} : { nextCursor: String(items.at(-1)?.sequence) }),
        hasMore: items.length === limit,
      };
    }
    case "t3_list_artifacts": {
      const environmentId = environmentWithScope(context, input, "artifact");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      const items = (Array.isArray(thread.artifacts) ? thread.artifacts : [])
        .slice(0, 2_000)
        .flatMap((artifact) => {
          try {
            const projected = gatewayArtifactRecord(artifact);
            return projected === undefined ? [] : [projected];
          } catch {
            return [];
          }
        });
      return { items };
    }
    case "t3_get_artifact": {
      const environmentId = environmentWithScope(context, input, "artifact");
      const threadId = requiredString(input, "threadId");
      const artifactId = requiredString(input, "artifactId");
      const thread = await context.port.getThread(environmentId, threadId);
      const artifact = (Array.isArray(thread.artifacts) ? thread.artifacts : [])
        .slice(0, 2_000)
        .flatMap((candidate) => {
          try {
            const projected = gatewayArtifactRecord(candidate);
            return projected === undefined ? [] : [projected];
          } catch {
            return [];
          }
        })
        .find((candidate) => candidate.artifactId === artifactId);
      if (artifact === undefined) {
        throw new GatewayError({
          code: "invalid_input",
          message: `Artifact ${artifactId} does not belong to thread ${threadId}.`,
          retryable: false,
          environmentId,
        });
      }
      if (artifact.availability !== "available") {
        throw new GatewayError({
          code: "invalid_input",
          message: `Artifact ${artifactId} is ${String(artifact.availability)}.`,
          retryable: false,
          environmentId,
        });
      }
      if (artifact.kind === "attachment" && typeof artifact.sourceId === "string") {
        const download = await context.port.createAssetUrl(environmentId, {
          _tag: "attachment",
          attachmentId: artifactId,
        });
        return { ...artifact, environmentId, threadId, download };
      }
      if (artifact.kind === "workspace-file" && typeof artifact.path === "string") {
        const download = await context.port.createAssetUrl(environmentId, {
          _tag: "workspace-file",
          threadId,
          path: artifact.path,
        });
        return { ...artifact, environmentId, threadId, download };
      }
      throw new GatewayError({
        code: "invalid_input",
        message: `Unsupported artifact record ${artifactId}.`,
        retryable: false,
        environmentId,
      });
    }
    case "t3_get_pr": {
      const environmentId = environmentWithScope(context, input, "review");
      return context.port.getPullRequest(environmentId, pullRequestRef(input));
    }
    case "t3_get_pr_checks": {
      const environmentId = environmentWithScope(context, input, "review");
      const detail = await context.port.getPullRequest(environmentId, pullRequestRef(input));
      return { items: Array.isArray(detail.checks) ? detail.checks : [] };
    }
    case "t3_list_review_comments": {
      const environmentId = environmentWithScope(context, input, "review");
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
    case "t3_modify_actions": {
      const environmentId = environmentWithScope(context, input, "approval");
      const idempotencyKey = requiredIdempotencyKey(input);
      const threadId = requiredString(input, "threadId");
      const requestedRevision = Number(input.planRevision);
      const modifications = Array.isArray(input.modifications) ? input.modifications : [];
      const execute = requireOperationPort(context);
      const authoritativeRequestId = scopedIdFor(
        "approval-plan",
        environmentId,
        threadId,
        idempotencyKey,
      );
      const legacyRequestId = idFor("approval-plan", idempotencyKey);
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("approval-plan", idempotencyKey)}`,
        idempotencyCommandPayload("approval.modify", input),
        (prepared) => {
          const dispatch = prepared ?? {
            payload: { threadId, planRevision: requestedRevision, modifications },
            requestId: authoritativeRequestId,
          };
          if (
            dispatch.requestId !== authoritativeRequestId &&
            dispatch.requestId !== legacyRequestId
          ) {
            throw new GatewayError({
              code: "idempotency_conflict",
              message: "This approval request has no recoverable authoritative command identity.",
              retryable: false,
              environmentId,
              requestId: authoritativeRequestId,
            });
          }
          return execute({
            environmentId,
            operation: "approval.modify",
            payload: dispatch.payload,
            requestId: dispatch.requestId,
          });
        },
        async () => {
          const thread = await context.port.getThread(environmentId, threadId);
          const plan = approvalPlan(thread);
          if (!Number.isInteger(requestedRevision) || requestedRevision !== plan.revision) {
            throw new GatewayError({
              code: "stale_plan",
              message: `Approval plan changed from revision ${String(input.planRevision)} to ${plan.revision}.`,
              retryable: false,
              environmentId,
              details: { approvalPlanId: plan.approvalPlanId, currentRevision: plan.revision },
            });
          }
          if (modifications.length === 0) {
            throw new GatewayError({
              code: "invalid_input",
              message: "modifications cannot be empty.",
              retryable: false,
              environmentId,
            });
          }
          for (const modification of modifications) {
            if (
              typeof modification !== "object" ||
              modification === null ||
              Array.isArray(modification)
            ) {
              throw new GatewayError({
                code: "invalid_input",
                message: "Each modification must identify one pending action.",
                retryable: false,
                environmentId,
              });
            }
            const value = modification as Record<string, unknown>;
            const action = plan.actions.find(
              (candidate) => candidate.approvalActionId === value.actionId,
            );
            const fields = record(value.fields);
            if (
              action === undefined ||
              fields === undefined ||
              Object.keys(fields).some(
                (field) =>
                  !(
                    Array.isArray(action.modifiableFields) &&
                    action.modifiableFields.includes(field)
                  ),
              )
            ) {
              throw new GatewayError({
                code: "invalid_input",
                message: `Action ${String(value.actionId)} contains fields that are not modifiable.`,
                retryable: false,
                environmentId,
              });
            }
            if (
              action.requiresDestructiveConfirmation === true &&
              (fields.decision === "accept" || fields.decision === "acceptForSession") &&
              input.confirmDestructive !== true
            ) {
              throw new GatewayError({
                code: "destructive_confirmation_required",
                message: `Action ${String(value.actionId)} requires confirmDestructive: true.`,
                retryable: false,
                environmentId,
              });
            }
          }
          return {
            payload: { threadId, planRevision: requestedRevision, modifications },
            requestId: authoritativeRequestId,
          };
        },
      );
    }
    case "t3_replay_events": {
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
      const limit =
        typeof input.limit === "number" ? Math.max(1, Math.min(500, Math.trunc(input.limit))) : 200;
      const items = events.pendingFor(subscriptionId, limit);
      return {
        subscriptionId,
        items,
        ackedSequence: subscription.ackedSequence,
        hasMore: items.length === limit,
      };
    }
    case "t3_git_status":
    case "t3_get_diff": {
      const environmentId = environmentWithScope(context, input, "read");
      const execute = requireOperationPort(context);
      return execute({
        environmentId,
        operation: name === "t3_git_status" ? "git.status" : "git.diff",
        payload: input,
        ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
      });
    }
    case "t3_apply_patch":
    case "t3_create_branch":
    case "t3_commit_changes":
    case "t3_create_pr":
    case "t3_update_pr":
    case "t3_reply_review_comment":
    case "t3_apply_review_fixes":
    case "t3_publish_pr": {
      const requiredScopes: ReadonlyArray<GatewayScope> =
        name === "t3_apply_patch" || name === "t3_create_branch" || name === "t3_commit_changes"
          ? ["admin"]
          : name === "t3_publish_pr"
            ? ["review", "admin"]
            : ["review"];
      const environmentId = environmentWithScopes(context, input, requiredScopes);
      const idempotencyKey = requiredIdempotencyKey(input);
      await assertProjectRepositoryAllowed(context, environmentId, input);
      if (name === "t3_publish_pr" && input.confirmDestructive !== true) {
        throw new GatewayError({
          code: "destructive_confirmation_required",
          message: "Publishing a pull request requires confirmDestructive: true.",
          retryable: false,
          environmentId,
        });
      }
      if (name === "t3_apply_patch") {
        assertPatchPathsAreProjectRelative(requiredString(input, "patch"));
      }
      if (name === "t3_create_pr") {
        const owner = requiredString(input, "owner");
        const projects = await context.port.listProjects(environmentId);
        const project = projects.items.find(
          (candidate) => candidate.id === requiredString(input, "projectId"),
        );
        const repositoryIdentity =
          typeof project?.repositoryIdentity === "object" && project.repositoryIdentity !== null
            ? (project.repositoryIdentity as Record<string, unknown>)
            : undefined;
        if (
          typeof repositoryIdentity?.owner !== "string" ||
          repositoryIdentity.owner !== owner ||
          typeof repositoryIdentity.name !== "string" ||
          repositoryIdentity.name !== requiredString(input, "repository")
        ) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Pull request owner ${owner} is outside the selected project's repository identity.`,
            retryable: false,
            environmentId,
          });
        }
        assertRepositoryAllowed(context, environmentId, owner, requiredString(input, "repository"));
      }
      const operations: Record<string, string> = {
        t3_apply_patch: "git.apply_patch",
        t3_create_branch: "git.create_branch",
        t3_commit_changes: "git.commit",
        t3_create_pr: "git.create_pr",
        t3_update_pr: "pr.update",
        t3_reply_review_comment: "pr.reply",
        t3_apply_review_fixes: "pr.apply_review_fixes",
        t3_publish_pr: "pr.publish",
      };
      const execute = requireOperationPort(context);
      const authoritativeRequestId = scopedIdFor(
        "operation",
        environmentId,
        requiredString(input, "projectId"),
        idempotencyKey,
      );
      const legacyRequestId = idFor("operation", idempotencyKey);
      return withIdempotency(
        context,
        `${environmentId}::${idFor("operation", idempotencyKey)}`,
        idempotencyCommandPayload(operations[name] as string, input),
        (prepared) => {
          if (
            prepared?.requestId !== authoritativeRequestId &&
            prepared?.requestId !== legacyRequestId
          ) {
            throw new GatewayError({
              code: "idempotency_conflict",
              message: "This operation has no recoverable authoritative command identity.",
              retryable: false,
              environmentId,
              requestId: authoritativeRequestId,
            });
          }
          return execute({
            environmentId,
            operation: operations[name] as string,
            payload: input,
            requestId: prepared.requestId,
          });
        },
        () => ({ requestId: authoritativeRequestId }),
      );
    }
    case "t3_create_thread": {
      const environmentId = environmentWithScope(context, input, "create");
      const idempotencyKey = requiredIdempotencyKey(input);
      // Explicit null opts out; otherwise a chat creating chats in its own environment parents them.
      const parentThreadId =
        input.parentThreadId === null
          ? undefined
          : typeof input.parentThreadId === "string"
            ? input.parentThreadId.trim()
            : invocation.caller?.environmentId === environmentId
              ? invocation.caller.threadId
              : undefined;
      const profileName = typeof input.profile === "string" ? input.profile.trim() : "";
      const profileIdInput = typeof input.profileId === "string" ? input.profileId.trim() : "";
      const legacyIdentity = {
        threadId: idFor("thread", idempotencyKey),
        requestId: idFor("request", idempotencyKey),
      };
      const currentThreadId = scopedIdFor("thread", environmentId, "create", idempotencyKey);
      const currentIdentity = {
        threadId: currentThreadId,
        requestId: scopedIdFor("thread", environmentId, currentThreadId, idempotencyKey),
      };
      const buildRequest = async (identity: typeof currentIdentity) => {
        await context.port.syncAgentLibrary?.(environmentId);
        const profiles = await authoritativeProfiles(context, environmentId);
        const profile =
          profileIdInput !== ""
            ? profiles.find((candidate) => candidate.profileId === profileIdInput)
            : profileName === ""
              ? undefined
              : profiles.find((candidate) => candidate.name === profileName);
        if ((profileName !== "" || profileIdInput !== "") && profile === undefined) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Unknown gateway profile ${profileIdInput || profileName}.`,
            retryable: false,
          });
        }
        if (
          profile !== undefined &&
          (typeof profile.profileId !== "string" ||
            profile.profileId.trim() === "" ||
            !Number.isInteger(profile.revision))
        ) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Gateway profile ${profile.name} is not a server-owned revisioned profile.`,
            retryable: false,
            environmentId,
          });
        }
        const authoritativeProfileRef =
          profile === undefined
            ? undefined
            : { profileId: profile.profileId as string, revision: profile.revision as number };
        if (
          profile !== undefined &&
          Array.isArray(profile.environmentIds) &&
          profile.environmentIds.length > 0 &&
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
        const hasThreadModel = input.modelSelection !== undefined;
        const profileModelSelection = hasThreadModel
          ? undefined
          : profile === undefined
            ? undefined
            : context.port.resolveProfileModelSelection === undefined
              ? profile.modelSelection
              : await context.port.resolveProfileModelSelection(environmentId, profile);
        const rawModelSelection = input.modelSelection ?? profileModelSelection;
        // Settings profiles persist readable labels, not routing keys. Resolve
        // those labels against the selected environment's live catalog at this
        // authoritative create boundary; only a missing/ambiguous profile pair
        // remains unresolved. With no selected profile or explicit override,
        // the server-owned provider/global default chain remains authoritative.
        if (rawModelSelection === undefined && profile !== undefined) {
          throw new GatewayError({
            code: "invalid_input",
            message: `Profile ${profile?.name ?? "requested"} provider/model is no longer uniquely available (provider: ${profile?.providerLabel ?? "unselected"}, model: ${profile?.modelLabel ?? "unselected"}); re-select the profile in Settings.`,
            retryable: false,
            environmentId,
            details: { profileId: profile?.profileId },
          });
        }
        const modelSelection =
          rawModelSelection === undefined ? undefined : record(rawModelSelection);
        // An agent's permission mode is owned by the user who defined it; callers
        // can neither lower nor escalate it for that agent's chats.
        const hasThreadRuntimeMode = profile === undefined && input.runtimeMode !== undefined;
        const hasThreadInteractionMode = input.interactionMode !== undefined;
        const requestedRuntimeMode = profile?.runtimeMode ?? input.runtimeMode;
        const requestedInteractionMode = input.interactionMode ?? profile?.interactionMode;
        const resolvedRuntimeMode:
          | "approval-required"
          | "auto"
          | "auto-accept-edits"
          | "full-access" =
          requestedRuntimeMode === "auto-accept-edits" ||
          requestedRuntimeMode === "auto" ||
          requestedRuntimeMode === "full-access"
            ? requestedRuntimeMode
            : "approval-required";
        const resolvedInteractionMode: "plan" | "default" =
          requestedInteractionMode === "plan" ? "plan" : "default";
        const reasoningEffort =
          typeof input.reasoningEffort === "string"
            ? input.reasoningEffort
            : profile?.reasoningEffort;
        const inheritedOptions = Array.isArray(modelSelection?.options)
          ? modelSelection.options.flatMap((candidate) => {
              const option = record(candidate);
              return option !== undefined &&
                typeof option.id === "string" &&
                (typeof option.value === "string" || typeof option.value === "boolean")
                ? [{ id: option.id, value: option.value }]
                : [];
            })
          : [];
        const modelOptions =
          reasoningEffort === undefined
            ? inheritedOptions
            : [
                ...inheritedOptions.filter((option) => option.id !== "reasoningEffort"),
                { id: "reasoningEffort", value: reasoningEffort },
              ];
        return {
          environmentId,
          projectId: requiredString(input, "projectId"),
          threadId: identity.threadId,
          title: requiredString(input, "title"),
          ...(modelSelection === undefined
            ? {}
            : {
                modelSelection: {
                  instanceId: requiredString(modelSelection, "instanceId"),
                  model: requiredString(modelSelection, "model"),
                  ...(modelOptions.length === 0 ? {} : { options: modelOptions }),
                },
              }),
          ...(resolvedRuntimeMode === undefined ? {} : { runtimeMode: resolvedRuntimeMode }),
          ...(resolvedInteractionMode === undefined
            ? {}
            : { interactionMode: resolvedInteractionMode }),
          ...(input.workspaceMode === undefined
            ? {}
            : { workspaceMode: input.workspaceMode as "checkout" | "worktree" }),
          ...(input.baseBranch === undefined
            ? {}
            : { baseBranch: requiredString(input, "baseBranch") }),
          ...(parentThreadId === undefined ? {} : { parentThreadId }),
          ...(authoritativeProfileRef === undefined
            ? {}
            : {
                profileSelection: {
                  ...authoritativeProfileRef,
                  overrideFields: [
                    ...(hasThreadModel ? (["modelSelection"] as const) : []),
                    ...(hasThreadRuntimeMode ? (["runtimeMode"] as const) : []),
                    ...(hasThreadInteractionMode ? (["interactionMode"] as const) : []),
                    ...(input.reasoningEffort !== undefined ? (["reasoningEffort"] as const) : []),
                  ],
                },
              }),
          requestId: identity.requestId,
        };
      };
      const recoverPreV2Create = async () => {
        const commandIds = [legacyIdentity.requestId, legacyIdentity.threadId];
        if (context.port.getCommandReceipts === undefined) {
          throw new GatewayError({
            code: "idempotency_conflict",
            message:
              "This interrupted legacy create cannot be recovered until the connected runtime supports authoritative receipt lookup.",
            retryable: false,
            environmentId,
          });
        }
        const receipts = await context.port.getCommandReceipts(environmentId, commandIds);
        const accepted = receipts.filter(
          (receipt) =>
            receipt.status === "accepted" &&
            receipt.aggregateKind === "thread" &&
            receipt.aggregateId === legacyIdentity.threadId &&
            commandIds.includes(receipt.commandId),
        );
        if (accepted.length !== 1) {
          throw new GatewayError({
            code: "idempotency_conflict",
            message:
              accepted.length === 0
                ? "No authoritative receipt exists for this interrupted legacy create."
                : "Multiple authoritative receipts exist for this interrupted legacy create.",
            retryable: false,
            environmentId,
            details: { candidateRequestIds: commandIds },
          });
        }
        const requestId = accepted[0]?.commandId as string;
        return {
          requestId,
          commandId: requestId,
          status: "accepted" as const,
          threadId: legacyIdentity.threadId,
        };
      };
      return withIdempotency(
        context,
        `${environmentId}::${idFor("thread", idempotencyKey)}`,
        input,
        async (prepared) =>
          prepared === undefined ? recoverPreV2Create() : context.port.createThread(prepared),
        () => buildRequest(currentIdentity),
      );
    }
    case "t3_create_and_start_thread": {
      const environmentId = environmentWithScopes(context, input, ["create", "send"]);
      const idempotencyKey = requiredIdempotencyKey(input);
      const messageText = requiredString(input, "text");
      const createInput = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "text"),
      );
      const creation = await callGatewayTool(context, "t3_create_thread", createInput, invocation);
      const threadId =
        typeof creation?.threadId === "string" ? (creation.threadId as string) : undefined;
      if (threadId === undefined) {
        throw new GatewayError({
          code: "upstream_failure",
          message: "Chat creation was accepted without an authoritative chat id.",
          retryable: true,
        });
      }
      const readShell = async () => {
        try {
          return await findGatewayThread(context, environmentId, threadId);
        } catch {
          return undefined;
        }
      };
      let message: Record<string, unknown> | null = null;
      let error: Record<string, unknown> | undefined;
      try {
        const sent = await callGatewayTool(context, "t3_send_message", {
          environmentId,
          threadId,
          text: messageText,
          idempotencyKey,
          ...(typeof input.correlationId === "string"
            ? { correlationId: input.correlationId }
            : {}),
        });
        message = {
          requestId: typeof sent?.requestId === "string" ? sent.requestId : null,
          messageId: typeof sent?.messageId === "string" ? sent.messageId : null,
          status: typeof sent?.status === "string" ? sent.status : "accepted",
        };
      } catch (caught) {
        // Creation already succeeded and is durably receipted under this
        // idempotency key. Return the reachable chat plus the delivery failure
        // so the caller can inspect or retry instead of creating a duplicate.
        error =
          caught instanceof GatewayError
            ? caught.toJSON()
            : {
                code: "upstream_failure",
                message: caught instanceof Error ? caught.message : String(caught),
                retryable: true,
              };
      }
      const finalThread = await readShell();
      const executionState =
        finalThread === undefined ? null : (readThreadExecutionState(finalThread) ?? null);
      return {
        environmentId,
        threadId,
        status: error === undefined ? "started" : "partial",
        partial: error !== undefined,
        retryable: error === undefined ? false : error.retryable === true,
        executionState,
        creation: {
          requestId: typeof creation?.requestId === "string" ? creation.requestId : null,
          status: typeof creation?.status === "string" ? creation.status : "accepted",
        },
        message,
        ...(error === undefined ? {} : { error }),
        ...(finalThread === undefined
          ? {}
          : {
              thread: {
                id: threadId,
                title: typeof finalThread.title === "string" ? finalThread.title : null,
                projectId: typeof finalThread.projectId === "string" ? finalThread.projectId : null,
                status: executionState,
                settledAt: finalThread.settledAt ?? null,
                updatedAt: finalThread.updatedAt ?? null,
              },
            }),
        snapshotAt: "runtime",
      };
    }
    case "t3_wait_for_thread_status": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScope(context, input, "read");
      const threadId = requiredString(input, "threadId");
      const untilStatuses = parseUntilStatuses(input.untilStatuses);
      const timeoutMs = boundedTimeoutMs(input.timeoutMs, 30_000);
      const requestedCursor =
        typeof input.afterSequence === "number"
          ? Math.max(0, Math.trunc(input.afterSequence))
          : events.latestSequence(environmentId);
      const cursorEvent =
        typeof input.afterSequence === "number"
          ? events.eventAtOrBefore(
              environmentId,
              threadId,
              requestedCursor,
              (event) => gatewayEventExecutionState(event) !== undefined,
            )
          : undefined;
      const baseline = await findGatewayThread(context, environmentId, threadId);
      const currentStatus =
        baseline === undefined ? null : (readThreadExecutionState(baseline) ?? null);
      // A resumed call compares against the status at its cursor. Reading the
      // current shell as the baseline would swallow changes between calls.
      const previousStatus =
        typeof input.afterSequence === "number"
          ? cursorEvent === undefined
            ? null
            : (gatewayEventExecutionState(cursorEvent) ?? null)
          : currentStatus;
      const matches = (candidate: GatewayThreadExecutionState | null | undefined): boolean => {
        if (candidate === undefined || candidate === null) return false;
        return untilStatuses === undefined
          ? candidate !== previousStatus
          : untilStatuses.includes(candidate);
      };
      // @effect-diagnostics-next-line globalDate:off - This tool handler is plain Node, not an Effect service; elapsed time is only reported to the caller.
      const startedAt = Date.now();
      let cursor = requestedCursor;
      let lastEvent: GatewayEvent | undefined;
      let status: GatewayThreadExecutionState | null = currentStatus;
      let matched = untilStatuses !== undefined && matches(currentStatus);
      let timedOut = false;
      if (!matched) {
        const deadline = startedAt + timeoutMs;
        for (;;) {
          // @effect-diagnostics-next-line globalDate:off - Plain Node tool handler; only bounds this wait.
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            timedOut = true;
            break;
          }
          const event = await events.waitForEvent({
            environmentId,
            threadId,
            afterSequence: cursor,
            timeoutMs: remaining,
            predicate: (candidate) => gatewayEventExecutionState(candidate) !== undefined,
          });
          if (event === undefined) {
            timedOut = true;
            break;
          }
          cursor = Math.max(cursor, event.sequence);
          lastEvent = event;
          const candidate = gatewayEventExecutionState(event);
          if (!matches(candidate)) continue;
          // Confirm against the authoritative shell so a replayed historical
          // event cannot satisfy a wait after the status already moved on.
          const verified = await findGatewayThread(context, environmentId, threadId).catch(
            () => undefined,
          );
          const verifiedStatus =
            verified === undefined ? candidate : (readThreadExecutionState(verified) ?? candidate);
          if (matches(verifiedStatus)) {
            status = verifiedStatus ?? status;
            matched = true;
            break;
          }
        }
      }
      const finalThread =
        (await findGatewayThread(context, environmentId, threadId).catch(() => undefined)) ??
        baseline;
      if (finalThread !== undefined) {
        status = readThreadExecutionState(finalThread) ?? status;
      }
      return {
        environmentId,
        threadId,
        status,
        previousStatus,
        changed: status !== previousStatus,
        matched,
        timedOut,
        // @effect-diagnostics-next-line globalDate:off - Reports elapsed wait time to the caller.
        waitedMs: Date.now() - startedAt,
        cursor: Math.max(cursor, events.latestSequence(environmentId), lastEvent?.sequence ?? 0),
        ...(lastEvent === undefined
          ? {}
          : {
              lastEvent: {
                eventId: lastEvent.eventId,
                type: lastEvent.type,
                sequence: lastEvent.sequence,
                occurredAt: lastEvent.occurredAt,
                ...(gatewayEventExecutionState(lastEvent) === undefined
                  ? {}
                  : { status: gatewayEventExecutionState(lastEvent) }),
              },
            }),
        thread:
          finalThread === undefined
            ? null
            : {
                id: typeof finalThread.id === "string" ? finalThread.id : threadId,
                title: typeof finalThread.title === "string" ? finalThread.title : null,
                projectId: typeof finalThread.projectId === "string" ? finalThread.projectId : null,
                status,
                settledAt: finalThread.settledAt ?? null,
                hasPendingApprovals: finalThread.hasPendingApprovals === true,
                hasPendingUserInput: finalThread.hasPendingUserInput === true,
                latestTurnState:
                  typeof finalThread.latestTurn === "object" && finalThread.latestTurn !== null
                    ? ((finalThread.latestTurn as Record<string, unknown>).state ?? null)
                    : null,
                sessionStatus:
                  typeof finalThread.session === "object" && finalThread.session !== null
                    ? ((finalThread.session as Record<string, unknown>).status ?? null)
                    : null,
                updatedAt: finalThread.updatedAt ?? null,
              },
        snapshotAt: "runtime",
      };
    }
    case "t3_send_message": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredIdempotencyKey(input);
      const threadId = requiredString(input, "threadId");
      const idempotencyStoreKey = `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`;
      const historicalRequestIds = [
        idFor("request", idempotencyKey),
        scopedIdFor("request", environmentId, threadId, idempotencyKey),
      ];
      const authoritativeRequestId = scopedIdFor(
        "message-send",
        environmentId,
        threadId,
        idempotencyKey,
      );
      const authoritativeMessageId = scopedIdFor(
        "message",
        environmentId,
        threadId,
        idempotencyKey,
      );
      await assertRecoverableHistoricalSend(
        context,
        idempotencyStoreKey,
        environmentId,
        threadId,
        authoritativeRequestId,
        historicalRequestIds,
      );
      return withIdempotency(
        context,
        idempotencyStoreKey,
        idempotencyCommandPayload("message.send", input),
        (prepared) =>
          context.port.sendMessage({
            environmentId,
            threadId,
            text: requiredString(input, "text"),
            messageId: prepared?.messageId ?? idFor("message", idempotencyKey),
            requestId: prepared?.requestId ?? idFor("request", idempotencyKey),
          }),
        () => ({ requestId: authoritativeRequestId, messageId: authoritativeMessageId }),
      );
    }
    case "t3_control_thread": {
      // `control` was shipped before the explicit v3 `lifecycle` scope. Keep
      // it as a narrow compatibility grant for thread control instead of
      // silently expanding it to any other v3 authority.
      const environmentId = environmentWithAnyScope(context, input, ["control", "lifecycle"]);
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
      const threadId = requiredString(input, "threadId");
      const authoritativeRequestId = scopedIdFor(
        "thread-control",
        environmentId,
        threadId,
        idempotencyKey,
      );
      const authoritativeMessageId = scopedIdFor(
        "message",
        environmentId,
        threadId,
        idempotencyKey,
      );
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`,
        idempotencyCommandPayload("thread.control", input),
        (prepared) =>
          context.port.controlThread({
            environmentId,
            threadId,
            action,
            requestId: prepared?.requestId ?? idFor("request", idempotencyKey),
            messageId: prepared?.messageId ?? idFor("message", idempotencyKey),
          }),
        () => ({ requestId: authoritativeRequestId, messageId: authoritativeMessageId }),
      );
    }
    case "t3_get_pending_questions": {
      const environmentId = environmentWithScope(context, input, "read");
      const thread = await context.port.getThread(environmentId, requiredString(input, "threadId"));
      return {
        environmentId,
        threadId: thread.id,
        title: thread.title,
        status: thread.status,
        pendingQuestions: pendingQuestionsOf(thread),
      };
    }
    case "t3_answer_question": {
      const environmentId = environmentWithScope(context, input, "send");
      const idempotencyKey = requiredIdempotencyKey(input);
      const threadId = requiredString(input, "threadId");
      const respond = context.port.respondToUserInput;
      if (respond === undefined) {
        throw new Error("Answering questions is unavailable in this runtime. Update T3.");
      }
      const answers = z
        .array(
          z.object({
            questionId: z.string().optional(),
            options: z.array(z.string()).optional(),
            text: z.string().optional(),
          }),
        )
        .min(1)
        .parse(input.answers);
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`,
        idempotencyCommandPayload("user-input.respond", input),
        async (prepared) => {
          const receipt = await respond({
            environmentId,
            threadId,
            userInputRequestId: prepared!.questionRequestId,
            answers: prepared!.answers,
            requestId: prepared!.requestId,
          });
          return {
            ...receipt,
            questionRequestId: prepared!.questionRequestId,
            answers: prepared!.answers,
          };
        },
        async () => {
          // Answers are checked against the live question, so a stale or
          // mistyped choice fails here instead of reaching the provider.
          const pending = pendingQuestionsOf(await context.port.getThread(environmentId, threadId));
          const wanted =
            typeof input.questionRequestId === "string" ? input.questionRequestId : undefined;
          const request =
            wanted === undefined
              ? pending.length === 1
                ? pending[0]
                : undefined
              : pending.find((candidate) => candidate.questionRequestId === wanted);
          if (request === undefined) {
            throw new GatewayError({
              code: pending.length === 0 || wanted !== undefined ? "stale_plan" : "invalid_input",
              message:
                pending.length === 0
                  ? "This chat is not waiting on a question."
                  : wanted === undefined
                    ? `This chat has ${pending.length} pending questions; pass questionRequestId.`
                    : `Question request ${wanted} is no longer pending. Read the pending questions again.`,
              retryable: false,
              environmentId,
              details: { threadId, pendingQuestions: pending },
            });
          }
          return {
            questionRequestId: request.questionRequestId,
            answers: resolveQuestionAnswers(request, answers),
            requestId: scopedIdFor("user-input-response", environmentId, threadId, idempotencyKey),
          };
        },
      );
    }
    case "t3_respond_to_approval": {
      const environmentId = environmentWithScope(context, input, "approval");
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
      const threadId = requiredString(input, "threadId");
      const authoritativeRequestId = scopedIdFor(
        "approval-response",
        environmentId,
        threadId,
        idempotencyKey,
      );
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("request", idempotencyKey)}`,
        idempotencyCommandPayload(`approval.respond.${decision}`, input),
        (prepared) =>
          context.port.respondToApproval({
            environmentId,
            threadId,
            approvalRequestId: requiredString(input, "approvalRequestId"),
            decision,
            requestId: prepared?.requestId ?? idFor("request", idempotencyKey),
          }),
        async () => {
          if (decision !== "accept" && decision !== "acceptForSession") {
            return { requestId: authoritativeRequestId };
          }
          const approvalRequestId = requiredString(input, "approvalRequestId");
          const thread = await context.port.getThread(environmentId, threadId);
          const plan = approvalPlan(thread);
          const action = plan.actions.find(
            (candidate) => candidate.approvalActionId === approvalRequestId,
          );
          // Fail closed for new dispatches: an action missing from the
          // reconstructed plan (unknown, resolved, or truncated out of the
          // newest-1,000 activity window) must never be treated as safe.
          // A durable dispatched marker lets an uncertain authoritative command
          // recover without granting that bypass to failed pre-dispatch checks.
          if (action === undefined) {
            throw new GatewayError({
              code: "stale_plan",
              message: `Approval request ${approvalRequestId} is not pending in the current approval plan. Re-fetch the plan and retry.`,
              retryable: false,
              environmentId,
              details: { approvalPlanId: plan.approvalPlanId, currentRevision: plan.revision },
            });
          }
          if (
            action.requiresDestructiveConfirmation === true &&
            input.confirmDestructive !== true
          ) {
            throw new GatewayError({
              code: "destructive_confirmation_required",
              message: `Action ${String(action.approvalActionId)} requires confirmDestructive: true.`,
              retryable: false,
              environmentId,
            });
          }
          return { requestId: authoritativeRequestId };
        },
      );
    }
    case "t3_approve_actions":
    case "t3_reject_actions": {
      const environmentId = environmentWithScope(context, input, "approval");
      const threadId = requiredString(input, "threadId");
      const idempotencyKey = requiredIdempotencyKey(input);
      const actionIds = requiredStringArray(input, "actionIds");
      const requestedRevision = Number(input.planRevision);
      const decision: GatewayApprovalDecision =
        name === "t3_approve_actions" ? "accept" : "decline";
      const authoritativeRequestId = scopedIdFor(
        "approval-plan",
        environmentId,
        threadId,
        idempotencyKey,
      );
      const legacyRequestId = idFor("approval-plan", idempotencyKey);
      return withIdempotency(
        context,
        `${environmentId}::${threadId}::${idFor("approval-plan", idempotencyKey)}`,
        idempotencyCommandPayload(`approval.respond.${decision}`, input),
        async (prepared) => {
          if (context.port.respondToApprovals === undefined) {
            throw new GatewayError({
              code: "not_configured",
              message: "The connected runtime does not support atomic grouped approvals.",
              retryable: false,
              environmentId,
            });
          }
          const dispatch = prepared ?? {
            approvalPlanId: `plan-${threadId}`,
            revision: requestedRevision,
            actionIds,
            decision,
            pending: 0,
            requestId: authoritativeRequestId,
          };
          if (
            dispatch.requestId !== authoritativeRequestId &&
            dispatch.requestId !== legacyRequestId
          ) {
            throw new GatewayError({
              code: "idempotency_conflict",
              message: "This approval request has no recoverable authoritative command identity.",
              retryable: false,
              environmentId,
              requestId: authoritativeRequestId,
            });
          }
          const receipt = await context.port.respondToApprovals({
            environmentId,
            threadId,
            responses: dispatch.actionIds.map((approvalRequestId) => ({
              approvalRequestId,
              decision: dispatch.decision,
            })),
            expectedRevision: dispatch.revision,
            requestId: dispatch.requestId,
          });
          return {
            approvalPlanId: dispatch.approvalPlanId,
            revision: dispatch.revision,
            approved: dispatch.decision === "accept" ? dispatch.actionIds.length : 0,
            rejected: dispatch.decision === "decline" ? dispatch.actionIds.length : 0,
            pending: dispatch.pending,
            receipt,
          };
        },
        async () => {
          const thread = await context.port.getThread(environmentId, threadId);
          const plan = approvalPlan(thread);
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
          return {
            approvalPlanId: plan.approvalPlanId,
            revision: plan.revision,
            actionIds: selected.map((action) => action.approvalActionId as string),
            decision,
            pending: plan.actions.length - selected.length,
            requestId: authoritativeRequestId,
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
      const types = Array.isArray(input.types)
        ? input.types.filter((candidate): candidate is string => typeof candidate === "string")
        : undefined;
      const history = events.history(environmentId, afterSequence, limit, types);
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
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
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
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      const types = Array.isArray(input.types)
        ? input.types.filter((t): t is string => typeof t === "string")
        : undefined;
      const patch = types === undefined ? {} : { types };
      return events.updateWebhook(environmentId, requiredString(input, "webhookId"), patch);
    }
    case "t3_rotate_webhook_secret": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      const { webhook, secret } = events.rotateWebhookSecret(
        environmentId,
        requiredString(input, "webhookId"),
      );
      return { ...webhook, secret, secretReference: `webhook-secret/${webhook.webhookId}` };
    }
    case "t3_delete_webhook": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
      events.deleteWebhook(environmentId, requiredString(input, "webhookId"));
      return { deleted: true };
    }
    case "t3_list_webhooks": {
      const events = requireEventStore(context);
      const environmentId = environmentWithScopes(context, input, ["read", "delivery"]);
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
