import { CommandCodeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCommandCodeTextGeneration } from "../../textGeneration/CommandCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCommandCodeAdapter } from "../Layers/CommandCodeAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { collectCommandCode } from "../commandCodeProcess.ts";
import { COMMAND_CODE_MODEL_CAPABILITIES, parseCommandCodeModels } from "../commandCodeProtocol.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER = ProviderDriverKind.make("commandcode");
const decodeSettings = Schema.decodeSync(CommandCodeSettings);
const decodeAuth = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ authenticated: Schema.Boolean })),
);
const presentation = {
  displayName: "Command Code",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  reportsContextWindow: false,
  supportsConversationRollback: false,
};
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: "command-code",
});
export type CommandCodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Crypto.Crypto
  | ServerConfig
  | ServerSettingsService;

export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Command Code", supportsMultipleInstances: true },
  configSchema: CommandCodeSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const environment = { ...mergeProviderInstanceEnvironment(input.environment), NO_COLOR: "1" };
      const config = { ...input.config, enabled: input.enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId: input.instanceId,
      });
      const stamp = withInstanceIdentity({
        ...input,
        driverKind: DRIVER,
        accentColor: input.accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const models = (stdout = "") =>
        providerModelsFromSettings(
          parseCommandCodeModels(stdout),
          config.customModels,
          COMMAND_CODE_MODEL_CAPABILITIES,
        );
      const initialSnapshot = Effect.gen(function* () {
        return stamp(
          buildServerProvider({
            driver: DRIVER,
            presentation,
            enabled: input.enabled,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
            models: models(),
            probe: {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
            },
          }),
        );
      });
      const probe = (args: readonly string[]) =>
        collectCommandCode({
          binaryPath: config.binaryPath,
          args: [...args, "--no-auto-update"],
          cwd: serverConfig.cwd,
          environment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.scoped,
          Effect.timeout("15 seconds"),
        );
      const checkProvider = Effect.gen(function* () {
        if (!input.enabled) return yield* initialSnapshot;
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const version = yield* probe(["--version"]);
        if (version.code !== 0)
          return stamp(
            buildServerProvider({
              driver: DRIVER,
              presentation,
              enabled: true,
              checkedAt,
              models: models(),
              probe: {
                installed: true,
                version: null,
                status: "error",
                auth: { status: "unknown" },
                message: version.stderr.trim() || "Command Code version check failed.",
              },
            }),
          );
        const [auth, catalog] = yield* Effect.all(
          [probe(["status", "--json"]), probe(["--list-models"])],
          { concurrency: "unbounded" },
        );
        const { authenticated } = yield* decodeAuth(auth.stdout);
        return stamp(
          buildServerProvider({
            driver: DRIVER,
            presentation,
            enabled: true,
            checkedAt,
            models: models(catalog.code === 0 ? catalog.stdout : ""),
            probe: {
              installed: true,
              version: parseGenericCliVersion(version.stdout),
              status: authenticated && auth.code === 0 ? "ready" : "error",
              auth: { status: authenticated ? "authenticated" : "unauthenticated" },
              ...(!authenticated || auth.code !== 0
                ? { message: "Sign in on this environment with commandcode login." }
                : {}),
            },
          }),
        );
      }).pipe(
        Effect.catch((cause) =>
          initialSnapshot.pipe(
            Effect.map((snapshot): ServerProvider => ({
              ...snapshot,
              installed: !isCommandMissingCause(cause),
              status: "error",
              message: isCommandMissingCause(cause)
                ? "Install Command Code with npm install -g command-code, then run commandcode login."
                : "Could not check Command Code. Verify its binary path, update the CLI, and run commandcode status.",
            })),
          ),
        ),
      );
      const source = makeProviderSnapshotSettingsSource(config, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<CommandCodeSettings>
      >({
        resolveMaintenance: () => Effect.succeed(maintenance),
        ...source,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => initialSnapshot,
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId: input.instanceId,
              detail: "Failed to create Command Code provider.",
              cause,
            }),
        ),
      );
      const adapter = yield* makeCommandCodeAdapter(config, {
        instanceId: input.instanceId,
        environment,
        cwd: serverConfig.cwd,
      });
      const textGeneration = yield* makeCommandCodeTextGeneration(config, environment);
      return {
        instanceId: input.instanceId,
        driverKind: DRIVER,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        continuationIdentity,
        snapshot,
        adapter,
        textGeneration,
      };
    }),
};
