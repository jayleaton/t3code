/**
 * `t3 watch <config.json>` - a host-owned, deterministic status watcher.
 *
 * It probes caller-configured resources (a file, an HTTP endpoint, a command's
 * exit status) and POSTs exactly one webhook per allow-listed transition, so a
 * T3 webhook task (and therefore a model run) only fires when something
 * actionable changes. Unchanged state sends nothing. It runs as its own
 * process and never inside the server; command probes run the configured argv
 * directly, without a shell.
 *
 * Delivery is crash safe: the event is persisted to the cursor as `pending`
 * before the POST, keyed `<name>:<seq>` in an `Idempotency-Key` header, and a
 * leftover pending event is re-sent with the same key on the next start.
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const MIN_INTERVAL_SECONDS = 5;
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const POST_TIMEOUT = Duration.seconds(15);
const MAX_BACKOFF_MS = 30_000;
const MAX_OUTPUT_CHARS = 200;

const NotifyList = Schema.NonEmptyArray(Schema.String);
const ProbeName = Schema.String.check(Schema.isNonEmpty());

const FileProbe = Schema.Struct({
  kind: Schema.Literal("file"),
  name: ProbeName,
  path: Schema.String.check(Schema.isNonEmpty()),
  notify: NotifyList,
  notifyInitial: Schema.optional(Schema.Boolean),
});
const HttpProbe = Schema.Struct({
  kind: Schema.Literal("http"),
  name: ProbeName,
  url: Schema.String.check(Schema.isNonEmpty()),
  timeoutMs: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  notify: NotifyList,
  notifyInitial: Schema.optional(Schema.Boolean),
});
const CommandProbe = Schema.Struct({
  kind: Schema.Literal("command"),
  name: ProbeName,
  argv: Schema.NonEmptyArray(Schema.String),
  timeoutMs: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  output: Schema.optional(Schema.Boolean),
  notify: NotifyList,
  notifyInitial: Schema.optional(Schema.Boolean),
});
const Probe = Schema.Union([FileProbe, HttpProbe, CommandProbe]);
type Probe = typeof Probe.Type;

export const WatchConfig = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  webhookUrl: Schema.String.check(Schema.isNonEmpty()),
  statePath: Schema.optional(Schema.String),
  intervalSeconds: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(MIN_INTERVAL_SECONDS)),
  ),
  probes: Schema.NonEmptyArray(Probe),
  deadlines: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isNonEmpty()),
        at: Schema.String,
        unless: Schema.Struct({ probe: Schema.String, value: Schema.String }),
      }),
    ),
  ),
  retry: Schema.optional(
    Schema.Struct({
      attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      baseDelayMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
export type WatchConfig = typeof WatchConfig.Type;

const EventBody = Schema.Struct({
  watch: Schema.String,
  event: Schema.String,
  probe: Schema.String,
  from: Schema.NullOr(Schema.String),
  to: Schema.String,
  state: Schema.Record(Schema.String, Schema.String),
  seq: Schema.Number,
  at: Schema.String,
});
type EventBody = typeof EventBody.Type;

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  seq: Schema.Number,
  state: Schema.Record(Schema.String, Schema.String),
  sentDeadlines: Schema.Array(Schema.String),
  pending: Schema.NullOr(
    Schema.Struct({
      key: Schema.String,
      body: EventBody,
      deadlineKey: Schema.optional(Schema.String),
    }),
  ),
});
type Cursor = typeof Cursor.Type;
type Pending = NonNullable<Cursor["pending"]>;

export class WatchConfigError extends Schema.TaggedError<WatchConfigError>()("WatchConfigError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Invalid watch config: ${this.detail}`;
  }
}

export class WatchStateError extends Schema.TaggedError<WatchStateError>()("WatchStateError", {
  path: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Cannot use watch state file ${this.path}: ${this.detail}`;
  }
}

export class WatchDeliveryPendingError extends Schema.TaggedError<WatchDeliveryPendingError>()(
  "WatchDeliveryPendingError",
  { key: Schema.String },
) {
  override get message(): string {
    return `Event ${this.key} is still pending delivery after retries; it will be re-sent with the same key on the next run.`;
  }
}

/** Hides the secret path segment of a T3 webhook URL for logs. */
export const redactWebhookUrl = (url: string): string =>
  url.replace(/\?.*$/, "").replace(/(\/hooks\/).*$/, "$1***");

const NOTIFY_PATTERNS: Record<Probe["kind"], RegExp | undefined> = {
  file: /^(present|absent)$/,
  http: /^(status:\d{3}|unreachable)$/,
  command: undefined,
};

const validateConfig = (config: WatchConfig): Effect.Effect<void, WatchConfigError> => {
  const fail = (detail: string) => Effect.fail(new WatchConfigError({ detail }));
  const names = new Set<string>();
  for (const probe of config.probes) {
    if (names.has(probe.name)) return fail(`duplicate probe name "${probe.name}"`);
    names.add(probe.name);
    const pattern = NOTIFY_PATTERNS[probe.kind];
    const outputMode = probe.kind === "command" && probe.output === true;
    for (const value of probe.notify) {
      if (value === "*" || outputMode || pattern === undefined) continue;
      if (!pattern.test(value)) {
        return fail(`probe "${probe.name}" (${probe.kind}) cannot notify on "${value}"`);
      }
    }
  }
  for (const deadline of config.deadlines ?? []) {
    if (Option.isNone(DateTime.make(deadline.at))) {
      return fail(`deadline "${deadline.name}" has an invalid "at" time`);
    }
    if (!names.has(deadline.unless.probe)) {
      return fail(`deadline "${deadline.name}" refers to unknown probe "${deadline.unless.probe}"`);
    }
  }
  return Effect.void;
};

const decodeConfigText = Schema.decodeUnknownEffect(Schema.fromJsonString(WatchConfig), {
  onExcessProperty: "error",
});

export const decodeWatchConfig = (text: string) =>
  decodeConfigText(text).pipe(
    Effect.mapError((error) => new WatchConfigError({ detail: String(error) })),
    Effect.tap(validateConfig),
  );

const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeEffect(Schema.fromJsonString(Cursor));

const sameState = (left: Record<string, string>, right: Record<string, string>) =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([key, value]) => right[key] === value);

const emptyCursor: Cursor = { version: 1, seq: 0, state: {}, sentDeadlines: [], pending: null };

const loadCursor = Effect.fn("watch.loadCursor")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return emptyCursor;
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((error) => new WatchStateError({ path, detail: String(error) })));
  return yield* decodeCursor(text).pipe(
    Effect.mapError(
      (error) => new WatchStateError({ path, detail: `not a valid cursor (${String(error)})` }),
    ),
  );
});

/** Writes next to the target, then renames, so readers never see a partial cursor. */
const saveCursor = Effect.fn("watch.saveCursor")(function* (path: string, cursor: Cursor) {
  const fs = yield* FileSystem.FileSystem;
  const temp = `${path}.tmp`;
  const text = yield* encodeCursor(cursor).pipe(
    Effect.mapError((error) => new WatchStateError({ path, detail: String(error) })),
  );
  yield* fs.writeFileString(temp, `${text}\n`).pipe(
    Effect.andThen(fs.rename(temp, path)),
    Effect.mapError((error) => new WatchStateError({ path, detail: String(error) })),
  );
});

const runProbe = Effect.fn("watch.runProbe")(function* (probe: Probe) {
  switch (probe.kind) {
    case "file": {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(probe.path).pipe(Effect.orElseSucceed(() => false));
      return exists ? "present" : "absent";
    }
    case "http": {
      const client = yield* HttpClient.HttpClient;
      return yield* client.execute(HttpClientRequest.get(probe.url)).pipe(
        Effect.timeout(Duration.millis(probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)),
        Effect.map((response) => `status:${String(response.status)}`),
        Effect.orElseSucceed(() => "unreachable"),
      );
    }
    case "command": {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const [file, ...args] = probe.argv;
      // No shell: argv goes straight to the OS.
      const command = ChildProcess.make(file, args, { stdin: "ignore", stderr: "ignore" });
      const run = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(command);
          const stdout = probe.output
            ? yield* Stream.decodeText(handle.stdout).pipe(Stream.mkString)
            : "";
          const code = yield* handle.exitCode;
          if (probe.output) {
            return stdout.trim().split(/\r?\n/, 1)[0]!.slice(0, MAX_OUTPUT_CHARS);
          }
          return `exit:${String(code)}`;
        }),
      );
      return yield* run.pipe(
        Effect.timeoutOption(Duration.millis(probe.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)),
        Effect.map(Option.getOrElse(() => "timeout")),
        Effect.orElseSucceed(() => "error"),
      );
    }
  }
});

type Delivery = "delivered" | "dropped" | "failed";

const deliver = Effect.fn("watch.deliver")(function* (config: WatchConfig, pending: Pending) {
  const client = yield* HttpClient.HttpClient;
  const attempts = config.retry?.attempts ?? 3;
  const baseDelayMs = config.retry?.baseDelayMs ?? 1_000;
  const redacted = redactWebhookUrl(config.webhookUrl);
  const request = HttpClientRequest.post(config.webhookUrl).pipe(
    HttpClientRequest.setHeader("Idempotency-Key", pending.key),
    HttpClientRequest.bodyJsonUnsafe(pending.body),
  );
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = yield* client.execute(request).pipe(
      Effect.timeout(POST_TIMEOUT),
      Effect.map((response) => response.status),
      Effect.orElseSucceed(() => 0),
    );
    if (status >= 200 && status < 300) return "delivered" as Delivery;
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable) {
      yield* Console.error(
        `watch: ${pending.key} rejected by ${redacted} with HTTP ${String(status)}; dropping this event as undeliverable.`,
      );
      return "dropped" as Delivery;
    }
    yield* Console.error(
      `watch: ${pending.key} to ${redacted} failed (${status === 0 ? "network error" : `HTTP ${String(status)}`}), attempt ${String(attempt)}/${String(attempts)}.`,
    );
    if (attempt < attempts && baseDelayMs > 0) {
      yield* Effect.sleep(
        Duration.millis(Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS)),
      );
    }
  }
  return "failed" as Delivery;
});

/**
 * One probe pass. Returns the key of an event still pending delivery, if any.
 * Probes are skipped while an earlier event is stuck, so order is preserved.
 */
export const watchOnce = Effect.fn("watch.once")(function* (
  config: WatchConfig,
  statePath: string,
) {
  let cursor = yield* loadCursor(statePath);

  // Commits a delivered/dropped pending event into the cursor.
  const settle = Effect.fn("watch.settle")(function* (pending: Pending) {
    cursor = {
      ...cursor,
      seq: pending.body.seq,
      state: pending.body.state,
      sentDeadlines:
        pending.deadlineKey === undefined
          ? cursor.sentDeadlines
          : [...cursor.sentDeadlines, pending.deadlineKey],
      pending: null,
    };
    yield* saveCursor(statePath, cursor);
  });

  // Persist before posting so a crash re-sends with the same key.
  const send = Effect.fn("watch.send")(function* (pending: Pending) {
    cursor = { ...cursor, pending };
    yield* saveCursor(statePath, cursor);
    const result = yield* deliver(config, pending);
    if (result === "failed") return false;
    yield* settle(pending);
    yield* Console.log(`watch: ${pending.key} ${pending.body.event} ${result}.`);
    return true;
  });

  if (cursor.pending !== null) {
    const ok = yield* send(cursor.pending);
    if (!ok) return Option.some(cursor.pending.key);
  }

  const observed = yield* Effect.forEach(config.probes, (probe) =>
    runProbe(probe).pipe(Effect.map((value) => [probe, value] as const)),
  );

  let running: Record<string, string> = { ...cursor.state };
  let seq = cursor.seq;
  const makeEvent = (event: string, probe: string, from: string | null, to: string, at: string) => {
    seq += 1;
    return {
      key: `${config.name}:${String(seq)}`,
      body: { watch: config.name, event, probe, from, to, state: { ...running }, seq, at },
    } satisfies Pending;
  };

  for (const [probe, value] of observed) {
    const previous = running[probe.name];
    if (previous === value) continue;
    running[probe.name] = value;
    const wanted = probe.notify.includes("*") || probe.notify.includes(value);
    if (previous === undefined && probe.notifyInitial !== true) continue;
    if (!wanted) continue;
    const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    const pending = makeEvent(
      `${probe.name}:${previous ?? "none"}->${value}`,
      probe.name,
      previous ?? null,
      value,
      at,
    );
    if (!(yield* send(pending))) return Option.some(pending.key);
    running = { ...cursor.state };
  }

  const nowMs = yield* Clock.currentTimeMillis;
  for (const deadline of config.deadlines ?? []) {
    const deadlineKey = `${deadline.name}@${deadline.at}`;
    const atMs = DateTime.toEpochMillis(DateTime.makeUnsafe(deadline.at));
    const current = running[deadline.unless.probe] ?? "unknown";
    if (cursor.sentDeadlines.includes(deadlineKey)) continue;
    if (nowMs < atMs || current === deadline.unless.value) continue;
    const base = makeEvent(
      `deadline_missed:${deadline.name}`,
      deadline.unless.probe,
      deadline.unless.value,
      current,
      DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    );
    const pending: Pending = { ...base, deadlineKey };
    if (!(yield* send(pending))) return Option.some(pending.key);
    running = { ...cursor.state };
  }

  // Silent transitions (baselines, non-allow-listed values) only move the cursor.
  if (!sameState(running, cursor.state) || seq !== cursor.seq) {
    cursor = { ...cursor, seq, state: running };
    yield* saveCursor(statePath, cursor);
  }
  return Option.none<string>();
});

export const defaultStatePath = (configPath: string) => `${configPath}.state.json`;

/** Runs `watchOnce` once, or forever every `intervalSeconds`. */
export const runWatch = Effect.fn("watch.run")(function* (input: {
  readonly configPath: string;
  readonly once: boolean;
  readonly intervalSeconds: Option.Option<number>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(input.configPath)
    .pipe(Effect.mapError((error) => new WatchConfigError({ detail: String(error) })));
  const config = yield* decodeWatchConfig(text);
  const statePath = config.statePath ?? defaultStatePath(input.configPath);
  const intervalSeconds = Option.getOrElse(
    input.intervalSeconds,
    () => config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
  );
  if (intervalSeconds < MIN_INTERVAL_SECONDS) {
    return yield* new WatchConfigError({
      detail: `interval must be at least ${String(MIN_INTERVAL_SECONDS)} seconds`,
    });
  }

  if (input.once) {
    const stuck = yield* watchOnce(config, statePath);
    if (Option.isSome(stuck)) return yield* new WatchDeliveryPendingError({ key: stuck.value });
    return;
  }
  return yield* Effect.forever(
    watchOnce(config, statePath).pipe(
      Effect.flatMap((stuck) =>
        Option.isSome(stuck)
          ? Console.error(`watch: ${stuck.value} still pending; retrying next interval.`)
          : Effect.void,
      ),
      Effect.andThen(Effect.sleep(Duration.seconds(intervalSeconds))),
    ),
  );
});

export const watchCommand = Command.make("watch", {
  config: Argument.String("config").pipe(
    Argument.withDescription("Path to the watch config JSON file."),
  ),
  once: Flag.Boolean("once").pipe(
    Flag.withDescription("Probe once and exit, for cron, launchd, systemd timers, or schtasks."),
    Flag.withDefault(false),
  ),
  interval: Flag.Int("interval").pipe(
    Flag.withDescription(
      `Seconds between probes when looping (minimum ${String(MIN_INTERVAL_SECONDS)}).`,
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Watch external state and POST one webhook per allow-listed change, never for unchanged state.",
  ),
  Command.withHandler((flags) =>
    runWatch({
      configPath: flags.config,
      once: flags.once,
      intervalSeconds: flags.interval,
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
