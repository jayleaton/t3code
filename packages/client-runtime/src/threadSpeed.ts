import type { OrchestrationLatestTurn, OrchestrationMessage } from "@t3tools/contracts";

export interface ThreadSpeedInput {
  readonly turn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
}

export interface ThreadSpeedSnapshot {
  readonly running: boolean;
  readonly tokensPerSecond: number | null;
  readonly estimatedOutputTokens: number;
  readonly elapsedMs: number;
  readonly firstOutputMs: number | null;
}

export const THREAD_SPEED_EXPLANATION =
  "Estimated from visible assistant text at 4 characters per token; accuracy varies by language and model. Excludes hidden reasoning and tool output. Live speed covers the last 5 seconds received by this client, including pauses. Completed speed averages the loaded visible output over the whole turn, including tools and waits. This is not the model’s internal generation speed.";

/** Sample once a second, using a monotonic clock for rates. A new observer starts
 * from the current text so opening a thread never counts history as live output. */
export function createThreadSpeedTracker() {
  let turnId: string | undefined;
  let messageIds = new Set<string>();
  let samples: Array<{ at: number; characters: number }> = [];
  return {
    reset() {
      turnId = undefined;
      samples = [];
      messageIds = new Set();
    },
    sample(
      input: ThreadSpeedInput,
      monotonicMs: number,
      wallClockMs: number,
    ): ThreadSpeedSnapshot | null {
      const turn = input.turn;
      if (!turn) {
        turnId = undefined;
        samples = [];
        return null;
      }
      const nextMessageIds = new Set<string>();
      let restoredText = false;
      let characters = 0;
      let firstOutputAt = Infinity;
      for (const message of input.messages) {
        if (message.turnId !== turn.turnId || message.role !== "assistant" || !message.text)
          continue;
        nextMessageIds.add(message.id);
        if (samples.length > 0 && !messageIds.has(message.id) && !message.streaming)
          restoredText = true;
        characters += message.text.length;
        firstOutputAt = Math.min(firstOutputAt, Date.parse(message.createdAt));
      }
      const running = turn.state === "running";
      const start = Date.parse(turn.requestedAt);
      const end = turn.completedAt ? Date.parse(turn.completedAt) : wallClockMs;
      const elapsedMs = Number.isFinite(end - start) ? Math.max(0, end - start) : 0;
      const firstOutputMs =
        Number.isFinite(firstOutputAt - start) && firstOutputAt >= start
          ? firstOutputAt - start
          : null;
      const last = samples.at(-1);
      // Suspended tabs, reconnects, compaction, and replaced snapshots must not
      // turn a batch of restored text into a speed spike.
      if (
        restoredText ||
        turnId !== turn.turnId ||
        !last ||
        monotonicMs <= last.at ||
        monotonicMs - last.at > 2500 ||
        characters < last.characters
      ) {
        samples = [];
      }
      turnId = turn.turnId;
      messageIds = nextMessageIds;
      samples.push({ at: monotonicMs, characters });
      while (samples.length > 1 && samples[0]!.at < monotonicMs - 5000) samples.shift();
      const first = samples[0]!;
      const observedMs = monotonicMs - first.at;
      const estimatedOutputTokens = Math.round(characters / 4);
      return {
        running,
        estimatedOutputTokens,
        elapsedMs,
        firstOutputMs,
        tokensPerSecond: running
          ? observedMs >= 1000
            ? (characters - first.characters) / 4 / (observedMs / 1000)
            : null
          : elapsedMs >= 1000
            ? characters / 4 / (elapsedMs / 1000)
            : null,
      };
    },
  };
}

export function formatThreadSpeed(snapshot: ThreadSpeedSnapshot | null): string {
  return snapshot?.tokensPerSecond == null
    ? snapshot && !snapshot.running
      ? "— tok/s"
      : "Measuring…"
    : `~${Math.round(snapshot.tokensPerSecond)} tok/s`;
}

export function formatSpeedDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
}
