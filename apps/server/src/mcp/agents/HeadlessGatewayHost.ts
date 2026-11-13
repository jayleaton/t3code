import { connectGatewayBridge, type GatewayBridgeState } from "@t3tools/client-runtime/gateway";
import {
  AGENT_GATEWAY_DEFAULT_SCOPES,
  AgentGatewaySettingError,
  type AgentGatewaySettings,
  type AgentGatewayStatus,
  type AgentGatewayUpdateInput,
  GATEWAY_SCOPE_VALUES,
  type GatewayScope,
} from "@t3tools/contracts";
import {
  sharedGatewayConfigFromEnvironment,
  sharedGatewayConfiguration,
  startSharedGatewayOwner,
  type SharedGatewayConfig,
} from "@t3tools/mcp-gateway/sharedOwner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";
import * as LocalGatewayPort from "./LocalGatewayPort.ts";

/** The desktop and MCP launchers read the bridge token from the same file. */
const GATEWAY_ENV_FILE = [".config", "t3code", "mcp-gateway.env"] as const;
const TOKEN_KEY = "T3_MCP_BRIDGE_TOKEN";

/** `KEY=value` lines, as systemd's EnvironmentFile and the desktop's credential reader accept. */
export function parseGatewayEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) continue;
    const raw = match[2]!.trim();
    const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0];
    values[match[1]!] = quoted ? raw.slice(1, -1) : raw;
  }
  return values;
}

/** This host's switches plus what `sharedGatewayConfigFromEnvironment` reads. */
const LAUNCHER_ENV_KEYS = [
  "T3_MCP_HEADLESS_GATEWAY",
  "T3_MCP_HEADLESS_SCOPES",
  "T3_MCP_BRIDGE_PORT",
  "T3_MCP_BRIDGE_TOKEN",
  "T3_MCP_REPOSITORY_ALLOWLIST",
  "T3_MCP_EVENT_RETENTION",
  "T3_MCP_STATE_FILE",
  "T3_MCP_GRANTS",
] as const;

/**
 * Removes the gateway launcher variables from the server's environment and returns them. Agents,
 * terminals, and provider SDKs all inherit that environment, so leaving them would hand every
 * agent the bridge token, and a dev server an agent starts would join the shared owner as a
 * standby runtime and take that role from this server.
 */
export const takeLauncherEnvironment = Effect.fn("HeadlessGatewayHost.takeLauncherEnvironment")(
  function* () {
    const env = yield* HostProcess.Environment;
    const taken: Record<string, string> = {};
    for (const key of LAUNCHER_ENV_KEYS) {
      const value = env[key];
      if (value === undefined) continue;
      taken[key] = value;
      delete env[key];
    }
    return taken;
  },
);

class GatewayOwnerStartError extends Schema.TaggedError<GatewayOwnerStartError>()(
  "GatewayOwnerStartError",
  { cause: Schema.Defect() },
) {}

/** What `takeLauncherEnvironment` removed from the process environment at startup. */
export class LauncherEnvironment extends Context.Service<
  LauncherEnvironment,
  Readonly<Record<string, string>>
>()("t3/mcp/agents/HeadlessGatewayHost/LauncherEnvironment") {}

type Env = Readonly<Record<string, string | undefined>>;

const isAgentGatewaySettingError = Schema.is(AgentGatewaySettingError);

/**
 * The saved setting, or `T3_MCP_HEADLESS_GATEWAY` and `T3_MCP_HEADLESS_SCOPES` until a client
 * has saved one, so a service unit that opted in before the setting existed keeps its gateway.
 */
export function effectiveGatewaySetting(
  setting: AgentGatewaySettings | null,
  env: Env,
): AgentGatewaySettings & { readonly problem?: string } {
  if (setting !== null) {
    return setting.enabled && !setting.scopes.includes("read")
      ? { ...setting, problem: "Agents need the read scope to use the gateway." }
      : setting;
  }
  const flag = env.T3_MCP_HEADLESS_GATEWAY?.trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const rawScopes = (env.T3_MCP_HEADLESS_SCOPES ?? AGENT_GATEWAY_DEFAULT_SCOPES.join(","))
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  const unknown = rawScopes.filter(
    (scope) => !GATEWAY_SCOPE_VALUES.includes(scope as GatewayScope),
  );
  const scopes = [...new Set(rawScopes)].filter((scope): scope is GatewayScope =>
    GATEWAY_SCOPE_VALUES.includes(scope as GatewayScope),
  );
  if (!enabled) return { enabled, scopes };
  if (unknown.length > 0) {
    return {
      enabled,
      scopes,
      problem: `T3_MCP_HEADLESS_SCOPES has unknown scopes: ${unknown.join(", ")}.`,
    };
  }
  if (!scopes.includes("read")) {
    return { enabled, scopes, problem: "T3_MCP_HEADLESS_SCOPES must include read." };
  }
  return { enabled, scopes };
}

function validToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token !== undefined && token.length >= 16 && !/\s/u.test(token) ? token : undefined;
}

/**
 * The owner's configuration. The file's token wins over the environment's, so a rotation, which
 * rewrites the file, takes effect; the environment still overrides every other value.
 */
export function resolveGatewayConfig(input: {
  readonly env: Env;
  readonly file: Readonly<Record<string, string>>;
  readonly homeDirectory: string;
  readonly baseDir: string;
}): { readonly config: SharedGatewayConfig } | { readonly problem: string } {
  const env = { ...input.file, ...stripUndefined(input.env) };
  const token = validToken(input.file[TOKEN_KEY]) ?? validToken(input.env[TOKEN_KEY]);
  try {
    // Launchers find the owner's store under the server's T3 home, as the desktop's do.
    const config = sharedGatewayConfigFromEnvironment(
      { ...env, [TOKEN_KEY]: token, T3CODE_HOME: env.T3CODE_HOME ?? input.baseDir },
      input.homeDirectory,
    );
    return { config };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

function stripUndefined(env: Env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Runs the gateway runtime for one configuration while the stream is consumed, emitting the
 * runtime bridge's state. Interrupting it closes the bridge and any owner it started.
 */
export type GatewayRuntime = (input: {
  readonly config: SharedGatewayConfig;
  readonly scopes: ReadonlyArray<GatewayScope>;
  readonly local: LocalGatewayPort.LocalGatewayPort["Service"];
}) => Stream.Stream<GatewayBridgeState>;

/**
 * Acquire the free bridge port or join its owner; stay standby while a desktop owns the runtime.
 * One owner, store and delivery worker prevent duplicate delivery.
 */
const sharedGatewayRuntime: GatewayRuntime = ({ config, scopes, local }) =>
  Stream.callback<GatewayBridgeState>((queue) =>
    Effect.gen(function* () {
      let owner: { readonly close: () => Promise<void> } | undefined;
      let closed = false;
      const holdOwner = Effect.gen(function* () {
        if (owner !== undefined || closed) return;
        // Undefined while another owner (a desktop app's) holds the port.
        const started = yield* Effect.tryPromise({
          try: () => startSharedGatewayOwner(config),
          catch: (cause) => new GatewayOwnerStartError({ cause }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Headless T3 Agents gateway owner failed to start.", { error }),
          ),
          Effect.orElseSucceed(() => undefined),
        );
        if (started === undefined) return;
        if (closed) yield* Effect.promise(() => started.close());
        else owner = started;
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed = true;
          await owner?.close();
        }),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          connectGatewayBridge({
            port: local.port,
            events: local.events,
            grants: { [local.environmentId]: scopes },
            url: `ws://127.0.0.1:${config.port}`,
            token: config.token,
            standby: true,
            reconnectDelayMs: 5_000,
            onState: (state) => void Queue.offerUnsafe(queue, state),
          }),
        ),
        (bridge) => Effect.sync(() => bridge.stop()),
      );
      yield* Effect.logInfo(
        `Headless T3 Agents gateway runtime on 127.0.0.1:${config.port} for ${local.environmentId} (${scopes.join(", ")}).`,
      );
      // Take over the owner role whenever a desktop app's owner exits and frees the port.
      yield* holdOwner.pipe(Effect.repeat(Schedule.spaced("15 seconds")), Effect.forkScoped);
    }),
  );

const DEFAULT_PORT = 47_631;

/**
 * The server-hosted T3 Agents gateway: headless thread events and signed webhooks need a gateway
 * runtime without a desktop app. A desktop-mode server leaves it to the desktop's renderer.
 */
export class HeadlessGatewayHost extends Context.Service<
  HeadlessGatewayHost,
  {
    readonly status: Stream.Stream<AgentGatewayStatus>;
    readonly update: (
      input: AgentGatewayUpdateInput,
    ) => Effect.Effect<AgentGatewayStatus, AgentGatewaySettingError>;
    /** The bridge token, created when there is none, for launchers on the server's machine. */
    readonly revealToken: Effect.Effect<string, AgentGatewaySettingError>;
    /** Replaces the token and restarts the owner with it, so launchers on the old one stop. */
    readonly rotateToken: Effect.Effect<string, AgentGatewaySettingError>;
    /** Runs the gateway for this environment, following the setting, until interrupted. */
    readonly run: (
      local: LocalGatewayPort.LocalGatewayPort["Service"],
    ) => Effect.Effect<never, never, Scope.Scope>;
  }
>()("t3/mcp/agents/HeadlessGatewayHost") {}

export const make = Effect.fn("HeadlessGatewayHost.make")(function* (runtime: GatewayRuntime) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const launcherEnvironment = yield* LauncherEnvironment;
  const processEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const homeDirectory = processEnvironment.HOME ?? "";
  const envFile = homeDirectory === "" ? undefined : path.join(homeDirectory, ...GATEWAY_ENV_FILE);
  const host: AgentGatewayStatus["host"] = serverConfig.mode === "desktop" ? "desktop" : "server";
  const env: Env = { ...processEnvironment, ...launcherEnvironment };

  const lock = yield* Semaphore.make(1);
  const running = yield* FiberHandle.make();
  let runningKey: string | undefined;
  let local: LocalGatewayPort.LocalGatewayPort["Service"] | undefined;
  const statusRef = yield* SubscriptionRef.make<AgentGatewayStatus>({
    host,
    enabled: false,
    scopes: [...AGENT_GATEWAY_DEFAULT_SCOPES],
    state: "disabled",
    port: DEFAULT_PORT,
  });

  const tokenFileError = (cause: unknown) =>
    new AgentGatewaySettingError({ reason: "token-file", cause });

  const readEnvFile = Effect.gen(function* () {
    if (envFile === undefined) return {};
    const info = yield* fileSystem.stat(envFile).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return {};
    const uid = Option.getOrUndefined(info.value.uid);
    // The file holds the bridge token; like the desktop, ignore it unless only its owner can read it.
    if ((info.value.mode & 0o077) !== 0 || (uid !== undefined && uid !== process.getuid?.())) {
      yield* Effect.logWarning(`Ignoring ${envFile}: it must be owned by you with mode 0600.`);
      return {};
    }
    return parseGatewayEnvFile(
      yield* fileSystem.readFileString(envFile).pipe(Effect.orElseSucceed(() => "")),
    );
  });

  /** Replaces the token line, keeping the file's other variables, as one owner-only rename. */
  const writeToken = Effect.fn("HeadlessGatewayHost.writeToken")(
    function* () {
      if (envFile === undefined) {
        return yield* new AgentGatewaySettingError({ reason: "token-file" });
      }
      const token = Buffer.from(yield* random.randomBytes(32)).toString("hex");
      const existing = yield* fileSystem
        .readFileString(envFile)
        .pipe(Effect.orElseSucceed(() => ""));
      const kept = existing
        .split(/\r?\n/u)
        .filter((line) => !new RegExp(`^\\s*(?:export\\s+)?${TOKEN_KEY}=`, "u").test(line));
      while (kept.at(-1) === "") kept.pop();
      const temporary = `${envFile}.tmp`;
      yield* fileSystem.makeDirectory(path.dirname(envFile), { recursive: true, mode: 0o700 });
      yield* fileSystem.writeFileString(
        temporary,
        [...kept, `${TOKEN_KEY}=${token}`, ""].join("\n"),
        {
          mode: 0o600,
        },
      );
      yield* fileSystem.chmod(temporary, 0o600);
      yield* fileSystem.rename(temporary, envFile);
      return token;
    },
    Effect.mapError((cause) => (isAgentGatewaySettingError(cause) ? cause : tokenFileError(cause))),
  );

  const currentToken = Effect.gen(function* () {
    const file = yield* readEnvFile;
    return validToken(file[TOKEN_KEY]) ?? validToken(env[TOKEN_KEY]);
  });

  const requireServerHost = Effect.suspend(() =>
    host === "desktop"
      ? Effect.fail(new AgentGatewaySettingError({ reason: "desktop-hosted" }))
      : Effect.void,
  );

  /** Brings the runtime and status in line with the setting, the token file and the port. */
  const reconcile = lock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.map((value) => value.agentGateway),
        Effect.orElseSucceed(() => null),
      );
      const setting = effectiveGatewaySetting(current, env);
      const stop = Effect.gen(function* () {
        yield* FiberHandle.clear(running);
        runningKey = undefined;
      });
      if (host === "desktop" || !setting.enabled || setting.problem !== undefined) {
        yield* stop;
        const problem = host === "desktop" ? undefined : setting.problem;
        if (problem !== undefined) {
          yield* Effect.logWarning(`Headless T3 Agents gateway is off: ${problem}`);
        }
        yield* SubscriptionRef.set(statusRef, {
          host,
          enabled: host === "server" && setting.enabled,
          scopes: setting.scopes,
          state: problem === undefined ? ("disabled" as const) : ("degraded" as const),
          ...(problem === undefined ? {} : { problem }),
          port: (yield* SubscriptionRef.get(statusRef)).port,
        });
        return;
      }
      // As the desktop does, an enabled gateway creates its token so it survives restarts.
      if ((yield* currentToken) === undefined) {
        yield* writeToken().pipe(
          Effect.catchTags({
            AgentGatewaySettingError: (error) =>
              Effect.logWarning("Could not create the gateway bridge token.", { error }),
          }),
        );
      }
      const resolved = resolveGatewayConfig({
        env,
        file: yield* readEnvFile,
        homeDirectory,
        baseDir: serverConfig.baseDir,
      });
      const base = { host, enabled: true, scopes: setting.scopes } as const;
      if ("problem" in resolved) {
        yield* stop;
        yield* Effect.logWarning(`Headless T3 Agents gateway is off: ${resolved.problem}`);
        yield* SubscriptionRef.set(statusRef, {
          ...base,
          state: "degraded",
          problem: resolved.problem,
          port: (yield* SubscriptionRef.get(statusRef)).port,
        });
        return;
      }
      const { config } = resolved;
      const key = [
        config.port,
        config.token,
        sharedGatewayConfiguration(config),
        setting.scopes.join(","),
      ].join("\n");
      if (local === undefined || key === runningKey) {
        if (key !== runningKey) {
          yield* SubscriptionRef.set(statusRef, {
            ...base,
            state: "connecting",
            port: config.port,
          });
        }
        return;
      }
      // Closed first, so a new owner can bind the port the old one held.
      yield* stop;
      runningKey = key;
      yield* SubscriptionRef.set(statusRef, { ...base, state: "connecting", port: config.port });
      yield* FiberHandle.run(
        running,
        runtime({ config, scopes: setting.scopes, local }).pipe(
          Stream.runForEach((state) =>
            SubscriptionRef.update(statusRef, (status) => ({ ...status, state })),
          ),
        ),
      );
    }),
  );

  const update = Effect.fn("HeadlessGatewayHost.update")(function* (
    input: AgentGatewayUpdateInput,
  ) {
    yield* requireServerHost;
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new AgentGatewaySettingError({ reason: "settings", cause })),
    );
    const effective = effectiveGatewaySetting(current.agentGateway, env);
    const next: AgentGatewaySettings = {
      enabled: input.enabled ?? effective.enabled,
      scopes: [...new Set(input.scopes ?? effective.scopes)],
    };
    if (next.enabled && !next.scopes.includes("read")) {
      return yield* new AgentGatewaySettingError({ reason: "missing-read-scope" });
    }
    yield* settings
      .updateSettings({ agentGateway: next })
      .pipe(
        Effect.mapError((cause) => new AgentGatewaySettingError({ reason: "settings", cause })),
      );
    yield* reconcile;
    return yield* SubscriptionRef.get(statusRef);
  });

  const revealToken = Effect.gen(function* () {
    yield* requireServerHost;
    const token = yield* currentToken;
    return token ?? (yield* writeToken());
  }).pipe(Effect.withSpan("HeadlessGatewayHost.revealToken"));

  const rotateToken = Effect.gen(function* () {
    yield* requireServerHost;
    const token = yield* writeToken();
    yield* reconcile;
    return token;
  }).pipe(Effect.withSpan("HeadlessGatewayHost.rotateToken"));

  const run = Effect.fn("HeadlessGatewayHost.run")(function* (
    port: LocalGatewayPort.LocalGatewayPort["Service"],
  ) {
    local = port;
    // Subscribed first, so a change saved while the first reconcile runs is not missed.
    const changes = yield* settings.subscribeChanges;
    yield* reconcile;
    yield* Stream.runForEach(changes, () => reconcile);
    return yield* Effect.never;
  });

  return HeadlessGatewayHost.of({
    status: SubscriptionRef.changes(statusRef),
    update,
    revealToken,
    rotateToken,
    run,
  });
});

export const layer = Layer.effect(HeadlessGatewayHost, make(sharedGatewayRuntime));

/** Starts the gateway runtime once the server is active. */
export const layerRuntime = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* HeadlessGatewayHost;
    const local = yield* LocalGatewayPort.LocalGatewayPort;
    yield* forkParked(host.run(local));
  }),
);
