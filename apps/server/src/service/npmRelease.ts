import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASE_MANIFEST_FILE,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  npmReleaseDatabaseMigration,
  parseChecksums,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import { APP_NAME } from "@t3tools/shared/branding";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const ReleaseIndex = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.optional(Schema.Boolean) }),
);
const decodeReleaseIndex = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseIndex));
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, t3code: Schema.Unknown })),
);
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

const RELEASE_INDEX_MAX_PAGES = 10;
const LOOKUP_TIMEOUT = Duration.seconds(30);

/** Release lookups for track switches. The RPC keeps its npm name; the fork publishes only
 * GitHub releases, so this reads them, never npm, whose `t3` is upstream's server. */
export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/service/npmRelease") {}

/** The newest published release on `channel`, paging past newer releases on other channels. */
export const findNewestReleaseVersion = Effect.fn("NpmRelease.findNewestReleaseVersion")(function* (
  channel: CliReleaseChannel,
) {
  const environment = yield* HostProcess.Environment;
  const token = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
    );
    const body = yield* fetchBytes(
      token === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${token}`),
      `Could not list ${APP_NAME} releases.`,
    );
    const releases = Option.getOrUndefined(
      decodeReleaseIndex(new TextDecoder().decode(Option.getOrElse(body, () => new Uint8Array()))),
    );
    if (releases === undefined) {
      return yield* new ServerNpmReleaseError({
        reason: `The ${APP_NAME} release index had an unexpected shape.`,
      });
    }
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return undefined;
});

/** The body of a 2xx response, or none for a 404. */
const fetchBytes = Effect.fn("NpmRelease.fetchBytes")(function* (
  request: HttpClientRequest.HttpClientRequest,
  reason: string,
) {
  const http = yield* HttpClient.HttpClient;
  const unavailable = new ServerNpmReleaseError({ reason });
  const response = yield* http.execute(request).pipe(
    Effect.timeout(LOOKUP_TIMEOUT),
    Effect.mapError(() => unavailable),
  );
  if (response.status === 404) return Option.none<Uint8Array>();
  if (response.status < 200 || response.status >= 300) return yield* unavailable;
  const bytes = yield* response.arrayBuffer.pipe(
    Effect.timeout(LOOKUP_TIMEOUT),
    Effect.mapError(() => unavailable),
  );
  return Option.some(new Uint8Array(bytes));
});

export const make = Effect.fn("NpmRelease.make")(function* () {
  const environment = yield* HostProcess.Environment;
  const baseUrl = environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined;
  const asset = (version: string, fileName: string, reason: string) =>
    fetchBytes(HttpClientRequest.get(cliReleaseAssetUrl(version, fileName, baseUrl)), reason);

  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      const version =
        spec === "latest" || spec === "nightly"
          ? yield* findNewestReleaseVersion(spec === "latest" ? "stable" : "nightly")
          : spec;
      if (version === undefined) return null;
      const sums = yield* asset(
        version,
        CLI_RELEASE_CHECKSUMS_FILE,
        "Could not read the release checksums.",
      );
      if (Option.isNone(sums)) return null;
      const expected = parseChecksums(new TextDecoder().decode(sums.value)).get(
        CLI_RELEASE_MANIFEST_FILE,
      );
      // Releases from before the manifest asset cannot prove their database support.
      if (expected === undefined) return { version };
      const bytes = yield* asset(
        version,
        CLI_RELEASE_MANIFEST_FILE,
        "Could not read the release manifest.",
      );
      const invalid = new ServerNpmReleaseError({
        reason: "The release returned invalid metadata.",
      });
      if (Option.isNone(bytes)) return yield* invalid;
      const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes.value));
      const manifest = Option.getOrUndefined(decodeManifest(new TextDecoder().decode(bytes.value)));
      if (Hex.encode(new Uint8Array(digest)) !== expected || manifest?.version !== version) {
        return yield* invalid;
      }
      const databaseMigration = npmReleaseDatabaseMigration(manifest);
      return {
        version,
        ...(databaseMigration === undefined ? {} : { databaseMigration }),
      } satisfies ServerNpmRelease;
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
