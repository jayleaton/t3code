import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { decodeWatchConfig, redactWebhookUrl, watchOnce, type WatchConfig } from "./watch.ts";

interface RecordedRequest {
  readonly url: string;
  readonly key: string | undefined;
  readonly body: Record<string, unknown>;
}

/** Fake webhook endpoint: `statuses` is consumed per POST; 0 means a network error. */
const makeHarness = (statuses: Array<number> = []) => {
  const requests: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) => {
    if (request.body._tag !== "Uint8Array") return Effect.die("unexpected body");
    requests.push({
      url: request.url,
      key: request.headers["idempotency-key"],
      body: JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>,
    });
    const status = statuses.shift() ?? 200;
    return status === 0
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));
  });
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "t3-watch-" });
    return yield* body(dir).pipe(
      Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)),
    );
  });

const WEBHOOK = "https://relay.example/hooks/secret-token";

const makeConfig = (dir: string, overrides: Partial<WatchConfig> = {}): WatchConfig => ({
  name: "lease",
  webhookUrl: WEBHOOK,
  probes: [{ kind: "file", name: "lease", path: `${dir}/lease`, notify: ["present"] }],
  retry: { attempts: 3, baseDelayMs: 0 },
  ...overrides,
});

/** Runs one pass, then advances the test clock so later passes see time move on. */
const pass = (config: WatchConfig, statePath: string) =>
  watchOnce(config, statePath).pipe(Effect.tap(() => TestClock.adjust(Duration.minutes(5))));

const readCursor = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(path)) as {
      seq: number;
      state: Record<string, string>;
      sentDeadlines: Array<string>;
      pending: { key: string } | null;
    };
  });

describe("t3 watch", () => {
  it.effect(
    "sends nothing while unchanged and exactly one keyed POST per allow-listed change",
    () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const harness = makeHarness();
          const statePath = `${dir}/state.json`;
          const config = makeConfig(dir);
          const run = pass(config, statePath).pipe(Effect.provide(harness.layer));

          for (let index = 0; index < 10; index += 1) yield* run;
          assert.strictEqual(harness.requests.length, 0);

          yield* fs.writeFileString(`${dir}/lease`, "x");
          const stuck = yield* run;
          assert.isTrue(Option.isNone(stuck));
          assert.strictEqual(harness.requests.length, 1);
          const [request] = harness.requests;
          assert.strictEqual(request!.key, "lease:1");
          assert.strictEqual(request!.url, WEBHOOK);
          assert.deepStrictEqual(
            { ...request!.body, at: undefined },
            {
              watch: "lease",
              event: "lease:absent->present",
              probe: "lease",
              from: "absent",
              to: "present",
              state: { lease: "present" },
              seq: 1,
              at: undefined,
            },
          );

          for (let index = 0; index < 5; index += 1) yield* run;
          assert.strictEqual(harness.requests.length, 1);
          const cursor = yield* readCursor(statePath);
          assert.deepStrictEqual(cursor.state, { lease: "present" });
          assert.strictEqual(cursor.seq, 1);
          assert.isNull(cursor.pending);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "records non-allow-listed transitions silently and keeps A to B to A to B keys distinct",
    () =>
      withDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const harness = makeHarness();
          const statePath = `${dir}/state.json`;
          const config = makeConfig(dir);
          const run = pass(config, statePath).pipe(Effect.provide(harness.layer));

          yield* fs.writeFileString(`${dir}/lease`, "x");
          yield* run; // baseline: present, nothing sent
          yield* fs.remove(`${dir}/lease`);
          yield* run; // ->absent is not allow-listed
          assert.strictEqual(harness.requests.length, 0);
          assert.deepStrictEqual((yield* readCursor(statePath)).state, { lease: "absent" });

          yield* fs.writeFileString(`${dir}/lease`, "x");
          yield* run;
          yield* fs.remove(`${dir}/lease`);
          yield* run;
          yield* fs.writeFileString(`${dir}/lease`, "x");
          yield* run;
          assert.deepStrictEqual(
            harness.requests.map((request) => request.key),
            ["lease:1", "lease:2"],
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends nothing for the first observation unless notifyInitial is set", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const quiet = makeHarness();
        yield* pass(makeConfig(dir), `${dir}/quiet.json`).pipe(Effect.provide(quiet.layer));
        assert.strictEqual(quiet.requests.length, 0);

        const loud = makeHarness();
        const config = makeConfig(dir, {
          probes: [
            {
              kind: "file",
              name: "lease",
              path: `${dir}/lease`,
              notify: ["present"],
              notifyInitial: true,
            },
          ],
        });
        yield* pass(config, `${dir}/loud.json`).pipe(Effect.provide(loud.layer));
        assert.strictEqual(loud.requests.length, 1);
        assert.strictEqual(loud.requests[0]!.body.from, null);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a failed event pending and re-sends it with the same key", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer)); // baseline absent
        yield* fs.writeFileString(`${dir}/lease`, "x");

        const down = makeHarness([503, 0, 429]);
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(down.layer));
        assert.deepStrictEqual(stuck, Option.some("lease:1"));
        assert.strictEqual(down.requests.length, 3);
        const failed = yield* readCursor(statePath);
        assert.strictEqual(failed.pending?.key, "lease:1");
        assert.deepStrictEqual(failed.state, { lease: "absent" });

        const up = makeHarness();
        const done = yield* pass(config, statePath).pipe(Effect.provide(up.layer));
        assert.isTrue(Option.isNone(done));
        assert.deepStrictEqual(
          up.requests.map((request) => request.key),
          ["lease:1"],
        );
        const cleared = yield* readCursor(statePath);
        assert.isNull(cleared.pending);
        assert.deepStrictEqual(cleared.state, { lease: "present" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("commits one event when a 5xx is followed by a 2xx within the retries", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer));
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const harness = makeHarness([500, 200]);
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(harness.layer));
        assert.isTrue(Option.isNone(stuck));
        assert.deepStrictEqual(
          harness.requests.map((request) => request.key),
          ["lease:1", "lease:1"],
        );
        const cursor = yield* readCursor(statePath);
        assert.isNull(cursor.pending);
        assert.strictEqual(cursor.seq, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drops a 4xx event but keeps the new state so it does not loop", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const statePath = `${dir}/state.json`;
        const config = makeConfig(dir);
        yield* pass(config, statePath).pipe(Effect.provide(makeHarness().layer));
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const harness = makeHarness([404]);
        const stuck = yield* pass(config, statePath).pipe(Effect.provide(harness.layer));
        assert.isTrue(Option.isNone(stuck));
        assert.strictEqual(harness.requests.length, 1);
        const cursor = yield* readCursor(statePath);
        assert.isNull(cursor.pending);
        assert.deepStrictEqual(cursor.state, { lease: "present" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fires a missed deadline once and never again", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const statePath = `${dir}/state.json`;
        // TestClock starts at the epoch, so any later ISO time is in the past once adjusted.
        const config = makeConfig(dir, {
          deadlines: [
            {
              name: "lease-by-noon",
              at: "1970-01-01T00:00:10.000Z",
              unless: { probe: "lease", value: "present" },
            },
          ],
        });
        const harness = makeHarness();
        const run = pass(config, statePath).pipe(Effect.provide(harness.layer));
        yield* run; // clock is already past `at` after pass() adjusts, but first pass runs at 0
        yield* run;
        yield* run;
        const deadlineRequests = harness.requests.filter((request) =>
          String(request.body.event).startsWith("deadline_missed:"),
        );
        assert.strictEqual(deadlineRequests.length, 1);
        assert.strictEqual(deadlineRequests[0]!.body.event, "deadline_missed:lease-by-noon");
        const cursor = yield* readCursor(statePath);
        assert.deepStrictEqual(cursor.sentDeadlines, ["lease-by-noon@1970-01-01T00:00:10.000Z"]);

        // A fresh run against the same cursor does not resend.
        const again = makeHarness();
        yield* pass(config, statePath).pipe(Effect.provide(again.layer));
        assert.strictEqual(again.requests.length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves no temp files behind", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(`${dir}/lease`, "x");
        const config = makeConfig(dir, {
          probes: [
            {
              kind: "file",
              name: "lease",
              path: `${dir}/lease`,
              notify: ["*"],
              notifyInitial: true,
            },
          ],
        });
        yield* pass(config, `${dir}/state.json`).pipe(Effect.provide(makeHarness().layer));
        const names = (yield* fs.readDirectory(dir))
          .map((entry) => path.basename(entry))
          .toSorted();
        assert.deepStrictEqual(names, ["lease", "state.json"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("turns a command's exit status into a transition without a shell", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const statePath = `${dir}/state.json`;
        const probe = (code: number) =>
          ({
            kind: "command",
            name: "job",
            argv: [process.execPath, "-e", `process.exit(${String(code)})`],
            notify: ["exit:3"],
          }) as const;
        const harness = makeHarness();
        const run = (code: number) =>
          watchOnce(makeConfig(dir, { probes: [probe(code)] }), statePath).pipe(
            Effect.provide(harness.layer),
          );
        yield* run(0);
        yield* run(0);
        assert.strictEqual(harness.requests.length, 0);
        yield* run(3);
        assert.strictEqual(harness.requests.length, 1);
        assert.strictEqual(harness.requests[0]!.body.event, "job:exit:0->exit:3");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unknown config keys and bad notify values", () =>
    Effect.gen(function* () {
      const base = {
        name: "w",
        webhookUrl: WEBHOOK,
        probes: [{ kind: "file", name: "f", path: "/x", notify: ["present"] }],
      };
      const excess = yield* decodeWatchConfig(JSON.stringify({ ...base, extra: 1 })).pipe(
        Effect.flip,
      );
      assert.strictEqual(excess._tag, "WatchConfigError");
      const badNotify = yield* decodeWatchConfig(
        JSON.stringify({
          ...base,
          probes: [{ kind: "file", name: "f", path: "/x", notify: ["exit:0"] }],
        }),
      ).pipe(Effect.flip);
      assert.match(badNotify.message, /cannot notify on "exit:0"/);
      const fast = yield* decodeWatchConfig(JSON.stringify({ ...base, intervalSeconds: 1 })).pipe(
        Effect.flip,
      );
      assert.strictEqual(fast._tag, "WatchConfigError");
    }),
  );

  it("redacts the webhook token", () => {
    assert.strictEqual(
      redactWebhookUrl("https://relay.example/hooks/abc123?x=1"),
      "https://relay.example/hooks/***",
    );
  });
});
