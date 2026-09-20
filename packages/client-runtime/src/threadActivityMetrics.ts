import {
  TurnTokenUsage,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ACTIVITY_PHASES = ["waiting", "tools", "thinking", "responding", "working"] as const;
export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];
export const ACTIVITY_LABELS: Record<ActivityPhase, string> = {
  waiting: "Waiting for you",
  tools: "Tool activity",
  thinking: "Reported thinking",
  responding: "Responding",
  working: "Other work",
};
export interface ThreadActivityInput {
  readonly turn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}
export const ACTIVITY_EXPLANATION =
  "Recorded activity across the whole turn, including scripts and tools. Concurrent work counts once: user waits take priority, then tools, reported thinking, and responses. Other work includes startup, unreported thinking, and gaps in the available history. These are activity durations, not CPU time or model inference speed.";
const decodeUsage = Schema.decodeUnknownOption(TurnTokenUsage);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
interface Span {
  phase: ActivityPhase;
  start: number;
  end: number;
  open: boolean;
}
interface Tool {
  start: number | null;
  end: number | null;
  title: string;
  failed: boolean;
}
const terminalStatuses = new Set(["completed", "failed", "declined", "interrupted", "cancelled"]);

/** Uses persisted timestamps, so reconnecting or opening a thread midway does
 * not restart its stopwatch. Unknown gaps are never attributed to thinking. */
export function deriveThreadActivity(input: ThreadActivityInput, now: number) {
  const turn = input.turn;
  if (!turn) return null;
  const start = Date.parse(turn.requestedAt);
  const running = turn.state === "running";
  const end = running ? now : Date.parse(turn.completedAt ?? turn.requestedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const until = Math.max(start, end);
  const spans: Span[] = [];
  const addSpan = (phase: ActivityPhase, from: number, to: number, open = false) => {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const lower = Math.max(start, from);
    const upper = Math.min(until, to);
    if (upper >= lower) spans.push({ phase, start: lower, end: upper, open: running && open });
  };
  for (const message of input.messages) {
    if (
      message.turnId !== turn.turnId ||
      !message.text ||
      (message.role !== "assistant" && message.role !== "reasoning")
    )
      continue;
    addSpan(
      message.role === "reasoning" ? "thinking" : "responding",
      Date.parse(message.createdAt),
      message.streaming ? until : Date.parse(message.updatedAt),
      message.streaming,
    );
  }
  const tools = new Map<string, Tool>();
  const waits = new Map<string, { start: number; end: number | null }>();
  let usage: TurnTokenUsage | null = null;
  const ordered = input.activities
    .filter((a) => a.turnId === turn.turnId || a.turnId === null)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0),
    );
  for (const activity of ordered) {
    const sameTurn = activity.turnId === turn.turnId;
    const at = Date.parse(activity.createdAt);
    if (!Number.isFinite(at) || at < start || at > until) continue;
    const payload = record(activity.payload);
    if (sameTurn && activity.kind === "turn.usage") {
      const parsed = decodeUsage(payload.tokenUsage);
      if (parsed._tag === "Some") usage = parsed.value;
    }
    if (
      sameTurn &&
      ["tool.started", "tool.updated", "tool.completed"].includes(activity.kind) &&
      typeof payload.toolCallId === "string"
    ) {
      const id = payload.toolCallId;
      const terminal =
        activity.kind === "tool.completed" ||
        (typeof payload.status === "string" && terminalStatuses.has(payload.status));
      const previous = tools.get(id);
      tools.set(id, {
        start: previous?.start ?? (terminal ? null : at),
        end: terminal ? at : (previous?.end ?? null),
        title: typeof payload.title === "string" ? payload.title : activity.summary,
        failed: previous?.failed === true || payload.status === "failed",
      });
    }
    const requested =
      activity.kind === "approval.requested" || activity.kind === "user-input.requested";
    const resolved =
      activity.kind === "approval.resolved" || activity.kind === "user-input.resolved";
    if ((requested || resolved) && typeof payload.requestId === "string") {
      // Message-mode questions do not pause the provider's native turn.
      if (requested && payload.responseMode === "message") continue;
      const id = `${activity.kind.split(".")[0]}:${payload.requestId}`;
      if (requested && sameTurn)
        waits.set(id, { start: waits.get(id)?.start ?? at, end: waits.get(id)?.end ?? null });
      else if (resolved) {
        const wait = waits.get(id);
        if (wait) wait.end = at;
      }
    }
  }
  for (const tool of tools.values())
    if (tool.start !== null) addSpan("tools", tool.start, tool.end ?? until, tool.end === null);
  for (const wait of waits.values())
    addSpan("waiting", wait.start, wait.end ?? until, wait.end === null);

  // Sweep interval boundaries; union parallel work instead of adding overlapping
  // durations. Priority makes the breakdown sum to elapsed wall time.
  const boundaries: Array<{ at: number; phase: ActivityPhase; delta: number }> = [];
  for (const span of spans) {
    if (span.end <= span.start) continue;
    boundaries.push(
      { at: span.start, phase: span.phase, delta: 1 },
      { at: span.end, phase: span.phase, delta: -1 },
    );
  }
  boundaries.sort((a, b) => a.at - b.at);
  const counts: Record<ActivityPhase, number> = {
    waiting: 0,
    tools: 0,
    thinking: 0,
    responding: 0,
    working: 0,
  };
  const durations = { ...counts };
  let cursor = start;
  let lastPhase: ActivityPhase = "working";
  let phaseSince = start;
  const accumulate = (to: number) => {
    if (to <= cursor) return;
    const phase = ACTIVITY_PHASES.find((p) => counts[p] > 0) ?? "working";
    if (phase !== lastPhase) phaseSince = cursor;
    durations[phase] += to - cursor;
    lastPhase = phase;
    cursor = to;
  };
  for (const boundary of boundaries) {
    accumulate(boundary.at);
    counts[boundary.phase] += boundary.delta;
  }
  accumulate(until);
  const currentPhase =
    ACTIVITY_PHASES.find((phase) => spans.some((span) => span.open && span.phase === phase)) ??
    "working";
  const activeTools = running
    ? [...tools.entries()].flatMap(([id, tool]) =>
        tool.start !== null && tool.end === null
          ? [{ id, title: tool.title, elapsedMs: until - tool.start }]
          : [],
      )
    : [];
  return {
    running,
    state: turn.state,
    currentPhase,
    currentPhaseMs: running && currentPhase === lastPhase ? until - phaseSince : 0,
    elapsedMs: until - start,
    durations,
    activeTools,
    totalTools: tools.size,
    finishedTools: [...tools.values()].filter((tool) => tool.end !== null).length,
    failedTools: [...tools.values()].filter((tool) => tool.failed).length,
    usage,
  };
}
export type ThreadActivitySnapshot = NonNullable<ReturnType<typeof deriveThreadActivity>>;
export function formatActivityDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function threadActivityLabel(snapshot: ThreadActivitySnapshot): string {
  if (!snapshot.running)
    return snapshot.state === "completed"
      ? "Completed"
      : snapshot.state === "interrupted"
        ? "Stopped"
        : "Failed";
  if (snapshot.currentPhase === "tools")
    return snapshot.activeTools.length > 1
      ? `${snapshot.activeTools.length} tools running`
      : "Running tool";
  if (snapshot.currentPhase === "working") return "Working";
  return ACTIVITY_LABELS[snapshot.currentPhase];
}
