import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import { notarizeAndStaple } from "./notarize-macos.ts";

interface Reply {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const appPath = "/tmp/dist/mac/T3 Code.app";
const ok: Reply = { exitCode: 0 };
const accepted: Reply = { exitCode: 0, stdout: '{"id":"abc","status":"Accepted"}' };
const networkLost: Reply = {
  exitCode: 68,
  stderr: 'NSURLErrorDomain Code=-1005 "The network connection was lost."',
};
const credentials = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: { APPLE_API_KEY: "/tmp/AuthKey.p8", APPLE_API_KEY_ID: "KEY", APPLE_API_ISSUER: "ISSUER" },
  }),
);

const text = (value: string | undefined) =>
  value ? Stream.make(new TextEncoder().encode(value)) : Stream.empty;

function fakeSpawner(respond: (args: ReadonlyArray<string>) => Reply) {
  const calls: string[] = [];
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const { command: executable, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      calls.push([executable, ...args.slice(0, 2)].join(" "));
      const reply = respond(args);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: text(reply.stdout),
          stderr: text(reply.stderr),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  return { calls, layer };
}

// Advances test time in steps until the run settles, so every retry delay
// elapses no matter when the fiber reaches it.
const runToCompletion = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const fiber = yield* notarizeAndStaple(appPath).pipe(
      Effect.provide(Layer.mergeAll(spawner, credentials)),
      Effect.result,
      Effect.forkChild,
    );
    const advance = TestClock.adjust("5 seconds").pipe(
      Effect.andThen(TestClock.withLive(Effect.sleep("1 millis"))),
      Effect.forever,
    );
    return yield* Effect.raceFirst(Fiber.join(fiber), advance);
  });

it.layer(NodeServices.layer)("notarizeAndStaple", (it) => {
  it.effect("retries a dropped staple connection until the ticket is stapled and validated", () =>
    Effect.gen(function* () {
      let staples = 0;
      const { calls, layer } = fakeSpawner((args) =>
        args[0] === "notarytool"
          ? accepted
          : args[1] === "staple" && ++staples < 3
            ? networkLost
            : ok,
      );

      const result = yield* runToCompletion(layer);

      assert.equal(result._tag, "Success");
      assert.deepStrictEqual(calls, [
        "ditto -c -k",
        "xcrun notarytool submit",
        "xcrun stapler staple",
        "xcrun stapler staple",
        "xcrun stapler staple",
        "xcrun stapler validate",
      ]);
    }),
  );

  it.effect("fails the build once every staple attempt is exhausted", () =>
    Effect.gen(function* () {
      const { calls, layer } = fakeSpawner((args) =>
        args[0] === "notarytool" ? accepted : args[1] === "staple" ? networkLost : ok,
      );

      const result = yield* runToCompletion(layer);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "NotarizeCommandFailedError");
        assert.match(result.failure.message, /exited with code 68[\s\S]*-1005/);
      }
      assert.equal(calls.filter((call) => call === "xcrun stapler staple").length, 6);
      assert.notInclude(calls, "xcrun stapler validate");
    }),
  );

  it.effect("staples again when validation fails", () =>
    Effect.gen(function* () {
      let validations = 0;
      const { calls, layer } = fakeSpawner((args) =>
        args[0] === "notarytool"
          ? accepted
          : args[1] === "validate" && ++validations < 2
            ? networkLost
            : ok,
      );

      const result = yield* runToCompletion(layer);

      assert.equal(result._tag, "Success");
      assert.equal(calls.filter((call) => call === "xcrun stapler staple").length, 2);
    }),
  );

  it.effect("resubmits after a transport failure", () =>
    Effect.gen(function* () {
      let submits = 0;
      const { calls, layer } = fakeSpawner((args) =>
        args[1] === "submit" ? (++submits < 2 ? networkLost : accepted) : ok,
      );

      const result = yield* runToCompletion(layer);

      assert.equal(result._tag, "Success");
      assert.equal(calls.filter((call) => call === "xcrun notarytool submit").length, 2);
    }),
  );

  it.effect("does not retry or staple an app Apple rejected", () =>
    Effect.gen(function* () {
      const { calls, layer } = fakeSpawner((args) =>
        args[1] === "submit"
          ? { exitCode: 0, stdout: '{"id":"abc","status":"Invalid"}' }
          : args[1] === "log"
            ? { exitCode: 0, stdout: "The binary is not signed." }
            : ok,
      );

      const result = yield* runToCompletion(layer);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "NotarizationRejectedError");
        assert.match(result.failure.message, /status: Invalid[\s\S]*The binary is not signed/);
      }
      assert.deepStrictEqual(calls, [
        "ditto -c -k",
        "xcrun notarytool submit",
        "xcrun notarytool log",
      ]);
    }),
  );

  it.effect("refuses to skip notarization without App Store Connect credentials", () =>
    Effect.gen(function* () {
      const { calls, layer } = fakeSpawner(() => ok);

      const result = yield* notarizeAndStaple(appPath).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: { APPLE_API_KEY: "/tmp/k.p8" } })),
          ),
        ),
        Effect.result,
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "NotaryCredentialsMissingError");
      }
      assert.deepStrictEqual(calls, []);
    }),
  );
});
