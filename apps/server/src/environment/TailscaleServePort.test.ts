import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";

import { chooseTailscaleServePort, writeLastTailscaleServePort } from "./TailscaleServePort.ts";

// Port 443 already forwards to another live T3 server on this machine.
const SERVE_STATUS_JSON = JSON.stringify({
  Web: { "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4077" } } } },
});

// NodeServices first: later layers win, so the mock spawner replaces the real one.
const layerTailscale = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(SERVE_STATUS_JSON)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
    ),
  ),
);

describe("chooseTailscaleServePort", () => {
  it.effect("skips a busy port, then keeps the port it used last", () =>
    Effect.gen(function* () {
      const stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const choose = (pinnedPort: number | undefined) =>
        chooseTailscaleServePort({ pinnedPort, stateDir, localPort: 3773 }).pipe(
          Effect.map(({ servePort, ownership }) => [servePort, ownership._tag]),
        );

      assert.deepEqual(yield* choose(undefined), [8443, "free"]);
      yield* writeLastTailscaleServePort(stateDir, 3445);
      assert.deepEqual(yield* choose(undefined), [3445, "free"]);
      assert.deepEqual(yield* choose(443), [443, "taken"]);
    }).pipe(Effect.scoped, Effect.provide(layerTailscale)),
  );
});
