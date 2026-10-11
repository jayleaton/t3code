import { CommandCodeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { makeCommandCodeTextGeneration } from "../../textGeneration/CommandCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCommandCodeAdapter } from "../CommandCodeAdapter.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "@t3tools/provider-core/server/snapshotProbe";
import { collectCommandCode } from "../commandCodeProcess.ts";
import { COMMAND_CODE_MODEL_CAPABILITIES, parseCommandCodeModels } from "../commandCodeProtocol.ts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

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
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocatorV2
  | FileSystem.FileSystem
  | McpProviderSessions.McpProviderSessions
  | ProviderHost;

export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Command Code", supportsMultipleInstances: true },
  configSchema: CommandCodeSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const host = yield* ProviderHost;
      const environment = {
        ...(yield* mergeProviderInstanceEnvironment(input.environment)),
        NO_COLOR: "1",
      };
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
          cwd: host.paths.cwd,
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
      const source = yield* makeProviderSnapshotSettingsSource(config);
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
        cwd: host.paths.cwd,
        attachmentsDir: host.paths.attachmentsDir,
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
        orchestrationAdapter: adapter,
        textGeneration,
      };
    }),
};
