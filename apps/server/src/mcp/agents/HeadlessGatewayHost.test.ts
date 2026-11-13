import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type GatewayScope } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  effectiveGatewaySetting,
  type GatewayRuntime,
  LauncherEnvironment,
  make,
  parseGatewayEnvFile,
  resolveGatewayConfig,
  takeLauncherEnvironment,
} from "./HeadlessGatewayHost.ts";
import type * as LocalGatewayPort from "./LocalGatewayPort.ts";

const TOKEN = "headless-token-0123456789";
const base = { homeDirectory: "/home/jj", baseDir: "/home/jj/.t3" };

describe("parseGatewayEnvFile", () => {
  it("reads systemd-style assignments, quotes, and comments", () => {
    expect(
      parseGatewayEnvFile(
        `# gateway\nT3_MCP_BRIDGE_TOKEN="${TOKEN}"\nexport T3_MCP_HEADLESS_GATEWAY=1\n\nnot a line\nT3_MCP_BRIDGE_PORT='47700'\n`,
      ),
    ).toEqual({
      T3_MCP_BRIDGE_TOKEN: TOKEN,
      T3_MCP_HEADLESS_GATEWAY: "1",
      T3_MCP_BRIDGE_PORT: "47700",
    });
  });
});

describe("takeLauncherEnvironment", () => {
  it.effect("keeps the gateway variables from children and hands them to the host", () =>
    Effect.gen(function* () {
      const launcher = {
        T3_MCP_HEADLESS_GATEWAY: "1",
        T3_MCP_HEADLESS_SCOPES: "read,delivery",
        T3_MCP_BRIDGE_PORT: "47700",
        T3_MCP_BRIDGE_TOKEN: TOKEN,
        T3_MCP_REPOSITORY_ALLOWLIST: "jayleaton/ada",
        T3_MCP_EVENT_RETENTION: "5000",
        T3_MCP_STATE_FILE: "/home/jj/.t3/mcp-gateway-v3.sqlite",
        T3_MCP_GRANTS: "{}",
      };
      const ordinary = { PATH: "/usr/bin", HOME: "/home/jj", TMPDIR: "/home/jj/.t3/tmp" };
      const env: NodeJS.ProcessEnv = { ...ordinary, ...launcher };

      const taken = yield* takeLauncherEnvironment().pipe(
        Effect.provideService(HostProcess.Environment, env),
      );

      expect(env).toEqual(ordinary);
      expect(taken).toEqual(launcher);
      expect(effectiveGatewaySetting(null, taken)).toEqual({
        enabled: true,
        scopes: ["read", "delivery"],
      });
      expect(resolveGatewayConfig({ ...base, env: { ...env, ...taken }, file: {} })).toMatchObject({
        config: { port: 47700, token: TOKEN },
      });
    }),
  );
});

describe("effectiveGatewaySetting", () => {
  it("follows T3_MCP_HEADLESS_GATEWAY only until a client saves the setting", () => {
    const on = { T3_MCP_HEADLESS_GATEWAY: "true", T3_MCP_HEADLESS_SCOPES: "read,send" };
    expect(effectiveGatewaySetting(null, {})).toEqual({
      enabled: false,
      scopes: ["read", "delivery"],
    });
    expect(effectiveGatewaySetting(null, on)).toEqual({ enabled: true, scopes: ["read", "send"] });
    expect(effectiveGatewaySetting({ enabled: false, scopes: ["read"] }, on)).toEqual({
      enabled: false,
      scopes: ["read"],
    });
  });

  it("reports why it cannot start", () => {
    const on = { T3_MCP_HEADLESS_GATEWAY: "1" };
    expect(
      effectiveGatewaySetting(null, { ...on, T3_MCP_HEADLESS_SCOPES: "read,everything" }),
    ).toMatchObject({ problem: expect.stringContaining("everything") });
    expect(
      effectiveGatewaySetting(null, { ...on, T3_MCP_HEADLESS_SCOPES: "delivery" }),
    ).toMatchObject({ problem: "T3_MCP_HEADLESS_SCOPES must include read." });
    expect(effectiveGatewaySetting({ enabled: true, scopes: ["send"] }, {})).toMatchObject({
      problem: "Agents need the read scope to use the gateway.",
    });
  });
});

describe("resolveGatewayConfig", () => {
  it("uses the desktop's store", () => {
    expect(
      resolveGatewayConfig({ ...base, env: {}, file: { T3_MCP_BRIDGE_TOKEN: TOKEN } }),
    ).toEqual({
      config: {
        port: 47631,
        token: TOKEN,
        stateFile: "/home/jj/.t3/mcp-gateway-v3.sqlite",
        retentionEvents: 100_000,
        repositoryAllowlist: ["jayleaton/ada", "jayleaton/t3code"],
        initialGrants: {},
      },
    });
  });

  it("lets the environment override the file, except the token a rotation writes there", () => {
    expect(
      resolveGatewayConfig({
        ...base,
        env: { T3_MCP_BRIDGE_PORT: "47700", T3_MCP_BRIDGE_TOKEN: "environment-token-0123456789" },
        file: { T3_MCP_BRIDGE_TOKEN: TOKEN, T3_MCP_BRIDGE_PORT: "1" },
      }),
    ).toMatchObject({ config: { port: 47700, token: TOKEN } });
  });

  it("reports a missing token", () => {
    expect(resolveGatewayConfig({ ...base, env: {}, file: {} })).toEqual({
      problem: "T3_MCP_BRIDGE_TOKEN must contain at least 16 characters.",
    });
  });
});

type RuntimeEvent =
  | { readonly type: "start"; readonly token: string; readonly scopes: ReadonlyArray<GatewayScope> }
  | { readonly type: "stop"; readonly token: string };

const local = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Host",
} as unknown as LocalGatewayPort.LocalGatewayPort["Service"];

const setup = Effect.fn("HeadlessGatewayHost.test.setup")(function* (
  options: {
    readonly mode?: "web" | "desktop";
    readonly launcher?: Record<string, string>;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-headless-gateway-" });
  const events = yield* Queue.unbounded<RuntimeEvent>();
  const runtime: GatewayRuntime = ({ config, scopes }) =>
    Stream.callback<"running">((queue) =>
      Effect.acquireRelease(
        Queue.offer(events, { type: "start", token: config.token, scopes }),
        () => Queue.offer(events, { type: "stop", token: config.token }),
      ).pipe(Effect.andThen(Queue.offer(queue, "running"))),
    );
  const layer = Layer.mergeAll(
    ServerSettings.ServerSettingsService.layerTest(),
    Layer.succeed(LauncherEnvironment, options.launcher ?? {}),
    Layer.succeed(HostProcess.Environment, { HOME: home }),
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        return { ...config, mode: options.mode ?? "web" };
      }),
    ).pipe(Layer.provide(ServerConfig.layerTest(home, { prefix: "t3-headless-gateway-config-" }))),
  );
  const { host, settings } = yield* Effect.gen(function* () {
    return {
      host: yield* make(runtime),
      settings: yield* ServerSettings.ServerSettingsService,
    };
  }).pipe(Effect.provide(yield* Layer.build(layer)));
  yield* host.run(local).pipe(Effect.forkScoped);
  return {
    host,
    settings,
    events,
    tokenFile: path.join(home, ".config", "t3code", "mcp-gateway.env"),
  };
});

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("HeadlessGatewayHost", () => {
  it.effect("starts and stops the runtime as the setting turns on and off", () =>
    provide(
      Effect.gen(function* () {
        const { host, events } = yield* setup();

        const enabled = yield* host.update({ enabled: true });
        expect(enabled).toMatchObject({
          host: "server",
          enabled: true,
          scopes: ["read", "delivery"],
        });
        const started = yield* Queue.take(events);
        expect(started).toMatchObject({ type: "start", scopes: ["read", "delivery"] });
        const running = yield* host.status.pipe(
          Stream.filter((status) => status.state === "running"),
          Stream.runHead,
        );
        expect(running._tag).toBe("Some");

        expect(yield* host.update({ enabled: false })).toMatchObject({
          enabled: false,
          state: "disabled",
        });
        expect(yield* Queue.take(events)).toMatchObject({ type: "stop" });
      }),
    ),
  );

  it.effect("grants outside agents only the saved scopes, and never without read", () =>
    provide(
      Effect.gen(function* () {
        const { host, settings, events } = yield* setup();

        yield* host.update({ enabled: true, scopes: ["read", "send"] });
        expect(yield* Queue.take(events)).toMatchObject({
          type: "start",
          scopes: ["read", "send"],
        });

        const refused = yield* host.update({ scopes: ["send"] }).pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "missing-read-scope" });
        expect((yield* settings.getSettings).agentGateway).toEqual({
          enabled: true,
          scopes: ["read", "send"],
        });

        yield* host.update({ scopes: ["read"] });
        expect(yield* Queue.take(events)).toMatchObject({ type: "stop" });
        expect(yield* Queue.take(events)).toMatchObject({ type: "start", scopes: ["read"] });
      }),
    ),
  );

  it.effect("follows the file's port and restarts the owner on a rotated token", () =>
    provide(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { host, events, tokenFile } = yield* setup();
        yield* fileSystem.makeDirectory(tokenFile.replace(/\/[^/]+$/u, ""), { recursive: true });
        yield* fileSystem.writeFileString(
          tokenFile,
          `T3_MCP_BRIDGE_PORT=47700\nT3_MCP_BRIDGE_TOKEN=${TOKEN}\n`,
          { mode: 0o600 },
        );
        expect(yield* host.update({ enabled: false })).toMatchObject({
          state: "disabled",
          port: 47700,
        });

        yield* host.update({ enabled: true });
        expect(yield* Queue.take(events)).toMatchObject({ type: "start", token: TOKEN });
        expect(yield* host.revealToken).toBe(TOKEN);

        const rotated = yield* host.rotateToken;
        expect(rotated).not.toBe(TOKEN);
        expect(yield* Queue.take(events)).toEqual({ type: "stop", token: TOKEN });
        expect(yield* Queue.take(events)).toMatchObject({ type: "start", token: rotated });
        expect(yield* host.revealToken).toBe(rotated);
        expect(yield* fileSystem.readFileString(tokenFile)).toBe(
          `T3_MCP_BRIDGE_PORT=47700\nT3_MCP_BRIDGE_TOKEN=${rotated}\n`,
        );
        expect((yield* fileSystem.stat(tokenFile)).mode & 0o777).toBe(0o600);
      }),
    ),
  );

  it.effect("creates a token when one is enabled without any", () =>
    provide(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { host, events, tokenFile } = yield* setup();

        yield* host.update({ enabled: true });
        const started = yield* Queue.take(events);
        expect(started.type).toBe("start");
        expect(yield* fileSystem.readFileString(tokenFile)).toBe(
          `T3_MCP_BRIDGE_TOKEN=${started.token}\n`,
        );
      }),
    ),
  );

  it.effect(
    "keeps a service unit's T3_MCP_HEADLESS_GATEWAY opt-in until the setting is saved",
    () =>
      provide(
        Effect.gen(function* () {
          const { host, events } = yield* setup({
            launcher: { T3_MCP_HEADLESS_GATEWAY: "1", T3_MCP_BRIDGE_TOKEN: TOKEN },
          });
          expect(yield* Queue.take(events)).toMatchObject({ type: "start", token: TOKEN });
          yield* host.update({ enabled: false });
          expect(yield* Queue.take(events)).toMatchObject({ type: "stop" });
        }),
      ),
  );

  it.effect("leaves a desktop-mode server's gateway to the desktop app", () =>
    provide(
      Effect.gen(function* () {
        const { host } = yield* setup({ mode: "desktop" });
        expect(yield* host.update({ enabled: true }).pipe(Effect.flip)).toMatchObject({
          reason: "desktop-hosted",
        });
        expect(yield* host.rotateToken.pipe(Effect.flip)).toMatchObject({
          reason: "desktop-hosted",
        });
        const status = yield* host.status.pipe(Stream.runHead);
        expect(status).toMatchObject({ value: { host: "desktop", enabled: false } });
      }),
    ),
  );
});
