// @effect-diagnostics nodeBuiltinImport:off - Hashes fixture release assets.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.5-nightly.20261030.1";
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const manifest = JSON.stringify({ name: "t3", version, t3code: { databaseMigration: 42 } });
const index = (page: string | null) =>
  page === "1"
    ? [{ tag_name: "v0.1.6-preview.20261031.1" }, { tag_name: `v${version}` }]
    : page === "2"
      ? [{ tag_name: "v0.1.4" }]
      : [];

type Asset = string | number;
const makeService = Effect.fnUntraced(function* (
  assets: Readonly<Record<string, Asset>>,
  environment: NodeJS.ProcessEnv = {},
) {
  const urls: string[] = [];
  const service = yield* NpmRelease.make().pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        urls.push(request.url);
        const url = new URL(request.url);
        const body: Asset =
          url.hostname === "api.github.com"
            ? JSON.stringify(index(url.searchParams.get("page")))
            : (assets[url.pathname] ?? 404);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            typeof body === "number" ? new Response("", { status: body }) : new Response(body),
          ),
        );
      }),
    ),
    Effect.provideService(HostProcess.Environment, environment),
  );
  return { service, urls };
});

const releasePath = (file: string) => `/jayleaton/t3code/releases/download/v${version}/${file}`;
const published = {
  [releasePath("SHA256SUMS")]:
    `${sha256(manifest)}  t3-release.json\n${"a".repeat(64)}  t3-${version}-linux-x64.tar.gz\n`,
  [releasePath("t3-release.json")]: manifest,
};

it.effect.each(["nightly", version])(
  "reads %s from the fork's releases with its checked database migration",
  (spec) =>
    Effect.gen(function* () {
      const { service, urls } = yield* makeService(published);
      const expected = { version, databaseMigration: 42 };
      expect(yield* service.get({ spec })).toEqual(expected);
      const requests = urls.length;
      expect(yield* service.get({ spec })).toEqual(expected);
      expect(urls).toHaveLength(requests);
      expect(urls.every((url) => !url.includes("npmjs"))).toBe(true);
      yield* TestClock.adjust("1 minute");
      expect(yield* service.get({ spec })).toEqual(expected);
      expect(urls).toHaveLength(requests * 2);
    }),
);

it.effect("reads release assets from the configured release mirror", () =>
  Effect.gen(function* () {
    const mirrored = Object.fromEntries(
      Object.entries(published).map(([path, body]) => [
        path.replace("/jayleaton/t3code/releases/download", "/mirror"),
        body,
      ]),
    );
    const { service, urls } = yield* makeService(mirrored, {
      T3CODE_RELEASE_BASE_URL: "https://mirror.example/mirror/",
    });
    expect(yield* service.get({ spec: version })).toEqual({ version, databaseMigration: 42 });
    expect(urls).toEqual([
      `https://mirror.example/mirror/v${version}/SHA256SUMS`,
      `https://mirror.example/mirror/v${version}/t3-release.json`,
    ]);
  }),
);

it.effect("treats a missing track or release as unpublished", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService({});
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
    // The fork has no stable release, and the index ends without one.
    expect(yield* service.get({ spec: "latest" })).toBeNull();
  }),
);

it.effect("reports a release without a manifest as predating database checks", () =>
  Effect.gen(function* () {
    const { service } = yield* makeService({
      [releasePath("SHA256SUMS")]: `${"a".repeat(64)}  t3-${version}-linux-x64.tar.gz\n`,
    });
    expect(yield* service.get({ spec: version })).toEqual({ version });
  }),
);

it.effect.each([
  {
    name: "a tampered manifest",
    assets: { ...published, [releasePath("t3-release.json")]: manifest.replace("42", "99") },
  },
  {
    name: "a manifest for another version",
    assets: {
      [releasePath("SHA256SUMS")]:
        `${sha256('{"version":"1.0.0","t3code":{"databaseMigration":1}}')}  t3-release.json\n`,
      [releasePath("t3-release.json")]: '{"version":"1.0.0","t3code":{"databaseMigration":1}}',
    },
  },
  {
    name: "a listed manifest that is missing",
    assets: { [releasePath("SHA256SUMS")]: published[releasePath("SHA256SUMS")]! },
  },
  { name: "a server error", assets: { [releasePath("SHA256SUMS")]: 502 } },
])("reports an unavailable lookup rather than an unpublished release for $name", ({ assets }) =>
  Effect.gen(function* () {
    const { service } = yield* makeService(assets);
    const found = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(found)).toBe(true);
    if (Result.isFailure(found)) expect(found.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before any request: %s",
  (spec) =>
    Effect.gen(function* () {
      const { service, urls } = yield* makeService({});
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
      expect(urls).toEqual([]);
    }),
);
