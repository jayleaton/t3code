import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// electron-builder's built-in notarization staples once: @electron/notarize
// 2.5.0 wraps stapleApp in promise-retry without calling `retry`, so a single
// dropped connection to Apple's ticket service fails the whole release build.
// This afterSign hook owns notarization instead and retries the network steps.
// It runs before electron-builder packs the DMG and zip, so both contain the
// stapled app, and it fails when it runs out of attempts so a signed build can
// never ship without a ticket.

class NotarizeCommandFailedError extends Schema.TaggedError<NotarizeCommandFailedError>()(
  "NotarizeCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int, output: Schema.String },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.\n${this.output}`;
  }
}

class NotarizationRejectedError extends Schema.TaggedError<NotarizationRejectedError>()(
  "NotarizationRejectedError",
  { status: Schema.String, submissionId: Schema.String, log: Schema.String },
) {
  override get message(): string {
    return `Apple rejected notarization (status: ${this.status}, id: ${this.submissionId}).\n${this.log}`;
  }
}

// A dropped connection to Apple is usually back within minutes. Staple waits
// 10s, 20s, 40s, 80s and 160s between attempts, about five minutes in total.
const SUBMIT_RETRY = { schedule: Schedule.exponential("30 seconds"), times: 2 };
const STAPLE_RETRY = { schedule: Schedule.exponential("10 seconds"), times: 5 };

class NotaryCredentialsMissingError extends Schema.TaggedError<NotaryCredentialsMissingError>()(
  "NotaryCredentialsMissingError",
  {},
) {
  override get message(): string {
    return "Signed macOS builds must be notarized: set APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID and APPLE_API_ISSUER.";
  }
}

const NotaryCredentials = Config.all({
  apiKey: Config.String("APPLE_API_KEY"),
  apiKeyId: Config.String("APPLE_API_KEY_ID"),
  apiIssuer: Config.String("APPLE_API_ISSUER"),
}).pipe(Effect.mapError(() => new NotaryCredentialsMissingError()));

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make(command, args));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectText(child.stdout), collectText(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode: Number(exitCode) };
    }),
  );

const runOrFail = Effect.fn("notarize.runOrFail")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const result = yield* run(command, args);
  if (result.exitCode !== 0) {
    return yield* new NotarizeCommandFailedError({
      command: [command, ...args.slice(0, 2)].join(" "),
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`,
    });
  }
});

const decodeSubmission = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, status: Schema.String })),
);

const submit = Effect.fn("notarize.submit")(function* (
  zipPath: string,
  auth: ReadonlyArray<string>,
) {
  const result = yield* run("xcrun", [
    "notarytool",
    "submit",
    zipPath,
    ...auth,
    "--wait",
    "--output-format",
    "json",
  ]);
  const submission = decodeSubmission(result.stdout.trim());
  if (submission._tag === "Some" && submission.value.status !== "Accepted") {
    const notaryLog = yield* run("xcrun", ["notarytool", "log", submission.value.id, ...auth]);
    return yield* new NotarizationRejectedError({
      status: submission.value.status,
      submissionId: submission.value.id,
      log: notaryLog.stdout,
    });
  }
  if (result.exitCode !== 0 || submission._tag === "None") {
    return yield* new NotarizeCommandFailedError({
      command: "xcrun notarytool submit",
      exitCode: result.exitCode,
      output: `${result.stdout}${result.stderr}`,
    });
  }
});

// Only a failed command is worth another attempt: Apple's verdict and a
// missing tool will not change on retry.
const retryCommandFailures =
  (label: string, options: typeof SUBMIT_RETRY) =>
  <A, E extends { readonly _tag: string; readonly message: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "NotarizeCommandFailedError"
          ? Effect.logWarning(`[notarize] ${label} failed.\n${error.message}`)
          : Effect.void,
      ),
      Effect.retry({ ...options, while: (error) => error._tag === "NotarizeCommandFailedError" }),
    );

export const notarizeAndStaple = Effect.fn("notarizeAndStaple")(function* (appPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentials = yield* NotaryCredentials;
  const auth = [
    "--key",
    credentials.apiKey,
    "--key-id",
    credentials.apiKeyId,
    "--issuer",
    credentials.apiIssuer,
  ];

  yield* Effect.scoped(
    Effect.gen(function* () {
      const workDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-notarize-" });
      const zipPath = path.join(workDir, `${path.basename(appPath, ".app")}.zip`);
      yield* runOrFail("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
      yield* submit(zipPath, auth).pipe(retryCommandFailures("notarytool submit", SUBMIT_RETRY));
    }),
  );
  yield* Effect.log(`[notarize] Notarized ${appPath}.`);

  yield* Effect.gen(function* () {
    yield* runOrFail("xcrun", ["stapler", "staple", "-v", appPath]);
    yield* runOrFail("xcrun", ["stapler", "validate", "-v", appPath]);
  }).pipe(retryCommandFailures("stapler", STAPLE_RETRY));
  yield* Effect.log(`[notarize] Stapled and validated ${appPath}.`);
});

interface AfterSignContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

export default async function afterSign(context: AfterSignContext): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;
  await Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* notarizeAndStaple(
      path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
}
