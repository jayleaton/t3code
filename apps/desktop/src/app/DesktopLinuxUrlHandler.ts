import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Linux ships as an AppImage, so the .desktop entry users end up with is
// normally created by an integration tool (AppImageLauncher names it
// appimagekit_<hash>-….desktop) and its filename is not under our control.
// Electron's app.setAsDefaultProtocolClient resolves the desktop id from
// setDesktopName, which cannot match those files — so the browser keeps
// prompting "Choose an application" for every OAuth callback. Instead, write
// our own handler entry pointing at the current AppImage and claim the
// scheme default via xdg-mime, exactly what the file manager's "set as
// default" checkbox would record in mimeapps.list.
//
// When no integrator has claimed the AppImage (a bare download from the
// release page), that hidden handler entry leaves the app invisible in
// launchers. In that case the entry is promoted to the real launcher instead:
// visible, with the AppImage's embedded hicolor icon installed into the user
// icon theme, the window class pinned via StartupWMClass, and the same
// --no-sandbox flag the AppImage's own integration template uses.
const { logInfo, logWarning } = makeComponentLogger("desktop-linux-url-handler");

export class DesktopLinuxUrlHandlerRegistrationError extends Schema.TaggedError<DesktopLinuxUrlHandlerRegistrationError>()(
  "DesktopLinuxUrlHandlerRegistrationError",
  {
    step: Schema.Literals(["write-desktop-entry", "set-default-handler"]),
    scheme: Schema.String,
    desktopEntryPath: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, xdg-mime exit code ${this.exitCode}`;
    return `Failed to register the ${this.scheme}:// URL handler (step: ${this.step}${exitCode}).`;
  }
}

const isRegistrationError = Schema.is(DesktopLinuxUrlHandlerRegistrationError);

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

// The AppImage integration entry owns the window identity and icon. This
// hidden URL-only entry must not compete with it for StartupWMClass matching.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly scheme: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)} %U`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

// electron-builder embeds the hicolor icons in the AppImage squashfs at
// usr/share/icons/hicolor/<size>x<size>/apps/t3code.png.
const LAUNCHER_ICON_SIZES = [512, 256, 128];
const LAUNCHER_ICON_FILE_NAME = "t3code.png";

// The visible launcher used when no integrator entry exists. It claims the
// window identity (StartupWMClass) and resolves Icon from the user hicolor
// theme copy installed by installLauncherIcon.
export function renderLauncherDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly scheme: string;
  readonly iconName: string;
  readonly wmClass: string;
  readonly noSandbox: boolean;
}): string {
  const sandboxArgs = input.noSandbox ? " --no-sandbox" : "";
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)}${sandboxArgs} %U`,
    "Terminal=false",
    "NoDisplay=false",
    "StartupNotify=false",
    `StartupWMClass=${escapeDesktopEntryString(input.wmClass)}`,
    `Icon=${escapeDesktopEntryString(input.iconName)}`,
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

// Integrator entries (appimagekit_…) point their Exec line at the AppImage.
// When one references the same AppImage it owns the launcher slot, so ours
// must stay the hidden scheme handler.
export function hasIntegratedLauncherEntry(input: {
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly content: string | null;
  }>;
  readonly ownEntryName: string;
  readonly appImagePath: string;
}): boolean {
  return input.entries.some(
    (entry) =>
      entry.name !== input.ownEntryName &&
      entry.name.endsWith(".desktop") &&
      entry.content !== null &&
      entry.content.includes(input.appImagePath),
  );
}

export class DesktopLinuxUrlHandler extends Context.Service<
  DesktopLinuxUrlHandler,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    environment.linuxDesktopEntryName,
  );
  const iconStem = environment.linuxDesktopEntryName.replace(/\.desktop$/, "");

  // Best-effort: without the icon copy the launcher entry still works and
  // falls back to a generic icon.
  const installLauncherIcon = Effect.gen(function* () {
    if (Option.isNone(environment.appImagePath)) {
      return;
    }
    const iconTarget = NodePath.posix.join(
      NodePath.posix.dirname(environment.linuxApplicationsDir),
      "icons",
      "hicolor",
      "512x512",
      "apps",
      `${iconStem}.png`,
    );
    const alreadyInstalled = yield* fileSystem
      .exists(iconTarget)
      .pipe(Effect.orElseSucceed(() => false));
    if (alreadyInstalled) {
      return;
    }
    // Inside the mounted AppImage, process.execPath points at the squashfs
    // root, so the embedded icons sit relative to it.
    const appImageMountRoot = NodePath.posix.dirname(process.execPath);
    for (const size of LAUNCHER_ICON_SIZES) {
      const iconSource = NodePath.posix.join(
        appImageMountRoot,
        "usr",
        "share",
        "icons",
        "hicolor",
        `${size}x${size}`,
        "apps",
        LAUNCHER_ICON_FILE_NAME,
      );
      const bytes = yield* fileSystem.readFile(iconSource).pipe(Effect.orElseSucceed(() => null));
      if (bytes === null) {
        continue;
      }
      yield* fileSystem.makeDirectory(NodePath.posix.dirname(iconTarget), { recursive: true });
      yield* fileSystem.writeFile(iconTarget, bytes);
      return;
    }
  }).pipe(Effect.ignore);

  const renderEntryContent = (execTarget: string) =>
    Effect.gen(function* () {
      const appImagePath = Option.getOrElse(
        environment.appImagePath,
        (): string | null => null,
      );
      if (appImagePath === null) {
        // Launching outside an AppImage (a development checkout) is not a
        // launcher install; keep the hidden handler entry.
        return renderUrlHandlerDesktopEntry({
          displayName: environment.displayName,
          execTarget,
          scheme,
        });
      }
      const entryNames = yield* fileSystem
        .readDirectory(environment.linuxApplicationsDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const entries = yield* Effect.forEach(entryNames, (name) =>
        fileSystem
          .readFileString(NodePath.posix.join(environment.linuxApplicationsDir, name))
          .pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((content) => ({ name, content })),
          ),
      );
      if (
        hasIntegratedLauncherEntry({
          entries,
          ownEntryName: environment.linuxDesktopEntryName,
          appImagePath,
        })
      ) {
        return renderUrlHandlerDesktopEntry({
          displayName: environment.displayName,
          execTarget,
          scheme,
        });
      }
      yield* installLauncherIcon;
      return renderLauncherDesktopEntry({
        displayName: environment.displayName,
        execTarget,
        scheme,
        iconName: iconStem,
        wmClass: environment.linuxWmClass,
        // electron-builder ships the AppImage integration template with
        // --no-sandbox; a launcher entry launching the same binary must match.
        noSandbox: true,
      });
    });

  const writeDesktopEntry = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the handler must launch the AppImage itself.
    const execTarget = Option.getOrElse(environment.appImagePath, () => process.execPath);
    const content = yield* renderEntryContent(execTarget);
    // Pre-ready setup normally wrote this already. Avoid truncating a valid
    // entry while the portal may be reading it during startup.
    const existing = yield* fileSystem
      .readFileString(desktopEntryPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing === content) return;
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    yield* fileSystem.writeFileString(desktopEntryPath, content);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "write-desktop-entry",
          scheme,
          desktopEntryPath,
          cause,
        }),
    ),
  );

  const setDefaultHandler = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "xdg-mime",
        ["default", environment.linuxDesktopEntryName, `x-scheme-handler/${scheme}`],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const handle = yield* spawner.spawn(command);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) {
        return yield* new DesktopLinuxUrlHandlerRegistrationError({
          step: "set-default-handler",
          scheme,
          exitCode: Number(exitCode),
        });
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "set-default-handler",
            scheme,
            cause: error,
          }),
    ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux") {
      return;
    }
    yield* writeDesktopEntry;
    if (!environment.isPackaged) return;
    yield* setDefaultHandler;
    yield* logInfo("registered URL scheme handler", { scheme });
  }).pipe(
    // Registration is best-effort: a missing xdg-mime or read-only home must
    // never block startup — the OS chooser remains as fallback.
    Effect.catch((error) =>
      logWarning("URL scheme handler registration failed", {
        scheme,
        step: error.step,
        message: error.message,
        ...(error.desktopEntryPath === undefined
          ? {}
          : { desktopEntryPath: error.desktopEntryPath }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      }),
    ),
    Effect.withSpan("desktop.linuxUrlHandler.register"),
  );

  return DesktopLinuxUrlHandler.of({ register });
});

export const layer = Layer.effect(DesktopLinuxUrlHandler, make);
