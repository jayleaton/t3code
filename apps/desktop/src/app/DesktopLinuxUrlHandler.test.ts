import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";

interface RecordedRegistration {
  readonly directories: string[];
  readonly files: Array<{ readonly path: string; readonly content: string }>;
  readonly binaries: Array<{ readonly path: string; readonly bytes: Uint8Array }>;
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
}

const makeEnvironment = (overrides: Record<string, unknown> = {}) =>
  DesktopEnvironment.DesktopEnvironment.of({
    platform: "linux",
    isPackaged: true,
    isDevelopment: false,
    displayName: "T3 Code (Alpha)",
    linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
    linuxWmClass: "t3code",
    linuxApplicationsDir: "/home/alice/.local/share/applications",
    appImagePath: Option.some("/home/alice/Applications/T3-Code.AppImage"),
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
    ...overrides,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const mockProcess = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const fileNotFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "FileNotFound",
    module: "FileSystem",
    method,
    description: "no such file",
    pathOrDescriptor: path,
  });

const makeHandlerLayer = (
  recorded: RecordedRegistration,
  input: {
    readonly environment?: Record<string, unknown>;
    readonly xdgMimeExitCode?: number;
    readonly writeError?: PlatformError.PlatformError;
    readonly existingEntry?: string;
    readonly directoryEntries?: ReadonlyArray<string>;
    readonly entryContents?: Record<string, string>;
    readonly iconBytes?: Uint8Array;
    readonly iconExists?: boolean;
  } = {},
) =>
  DesktopLinuxUrlHandler.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, makeEnvironment(input.environment)),
        FileSystem.layerNoop({
          readFileString: (path) => {
            const matched = Object.entries(input.entryContents ?? {}).find(([suffix]) =>
              path.endsWith(suffix),
            );
            if (matched !== undefined) {
              return Effect.succeed(matched[1]);
            }
            if (input.existingEntry !== undefined && path.includes("applications/")) {
              return Effect.succeed(input.existingEntry);
            }
            return Effect.fail(fileNotFound("readFileString", path));
          },
          readFile: (path) =>
            input.iconBytes !== undefined
              ? Effect.succeed(input.iconBytes)
              : Effect.fail(fileNotFound("readFile", path)),
          exists: (path) =>
            input.iconExists === true && path.endsWith(".png")
              ? Effect.succeed(true)
              : Effect.succeed(false),
          readDirectory: () => Effect.succeed([...(input.directoryEntries ?? [])]),
          makeDirectory: (path) =>
            Effect.sync(() => {
              recorded.directories.push(path);
            }),
          writeFileString: (path, content) =>
            input.writeError
              ? Effect.fail(input.writeError)
              : Effect.sync(() => {
                  recorded.files.push({ path, content });
                }),
          writeFile: (path, bytes) =>
            Effect.sync(() => {
              recorded.binaries.push({ path, bytes });
            }),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            recorded.commands.push({
              command: childProcess.command,
              args: childProcess.args,
            });
            return Effect.succeed(mockProcess(input.xdgMimeExitCode ?? 0));
          }),
        ),
      ),
    ),
  );

const runRegister = (
  recorded: RecordedRegistration,
  input: Parameters<typeof makeHandlerLayer>[1] = {},
) =>
  Effect.gen(function* () {
    const handler = yield* DesktopLinuxUrlHandler.DesktopLinuxUrlHandler;
    yield* handler.register;
  }).pipe(Effect.provide(makeHandlerLayer(recorded, input)));

const emptyRecording = (): RecordedRegistration => ({
  directories: [],
  files: [],
  binaries: [],
  commands: [],
});

describe("DesktopLinuxUrlHandler", () => {
  it("renders a scheme-handler desktop entry with freedesktop Exec quoting", () => {
    const entry = DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
      displayName: "T3 Code (Nightly)",
      execTarget: '/home/al ice/Apps/T3 "100%" $HOME\\x.AppImage',
      scheme: "t3code",
    });

    assert.include(entry, "[Desktop Entry]");
    assert.include(entry, "Name=T3 Code (Nightly)");
    // Exec composes both escaping layers: a literal backslash becomes four
    // backslashes in the file, a quote three characters, a dollar sign two
    // backslashes plus the sign.
    assert.include(
      entry,
      'Exec="/home/al ice/Apps/T3 \\\\"100%%\\\\" \\\\$HOME\\\\\\\\x.AppImage" %U',
    );
    assert.include(entry, "NoDisplay=true");
    assert.notInclude(entry, "StartupWMClass=");
    assert.notInclude(entry, "Icon=");
    assert.include(entry, "MimeType=x-scheme-handler/t3code;");
  });

  it("renders a launcher desktop entry with icon, window class, and the AppImage sandbox flag", () => {
    const entry = DesktopLinuxUrlHandler.renderLauncherDesktopEntry({
      displayName: "T3 Code (Nightly)",
      execTarget: '/home/al ice/Apps/T3 "100%" $HOME\\x.AppImage',
      scheme: "t3code",
      iconName: "com.t3tools.T3Code",
      wmClass: "t3code",
      noSandbox: true,
    });

    assert.include(entry, "[Desktop Entry]");
    assert.include(entry, "Name=T3 Code (Nightly)");
    assert.include(
      entry,
      'Exec="/home/al ice/Apps/T3 \\\\"100%%\\\\" \\\\$HOME\\\\\\\\x.AppImage" --no-sandbox %U',
    );
    assert.include(entry, "NoDisplay=false");
    assert.include(entry, "StartupWMClass=t3code");
    assert.include(entry, "Icon=com.t3tools.T3Code");
    assert.include(entry, "MimeType=x-scheme-handler/t3code;");
  });

  it("detects an integrator entry only when it references the same AppImage", () => {
    const appImagePath = "/home/alice/Applications/T3-Code.AppImage";
    assert.isTrue(
      DesktopLinuxUrlHandler.hasIntegratedLauncherEntry({
        entries: [
          { name: "appimagekit_abc123-T3-Code.desktop", content: `Exec="${appImagePath}" %U` },
        ],
        ownEntryName: "com.t3tools.T3Code.desktop",
        appImagePath,
      }),
    );
    assert.isFalse(
      DesktopLinuxUrlHandler.hasIntegratedLauncherEntry({
        entries: [
          {
            name: "appimagekit_abc123-T3-Code.desktop",
            content: 'Exec="/home/alice/Applications/Other.AppImage" %U',
          },
        ],
        ownEntryName: "com.t3tools.T3Code.desktop",
        appImagePath,
      }),
    );
    assert.isFalse(
      DesktopLinuxUrlHandler.hasIntegratedLauncherEntry({
        entries: [{ name: "com.t3tools.T3Code.desktop", content: `Exec="${appImagePath}"` }],
        ownEntryName: "com.t3tools.T3Code.desktop",
        appImagePath,
      }),
    );
    assert.isFalse(
      DesktopLinuxUrlHandler.hasIntegratedLauncherEntry({
        entries: [{ name: "notes.txt", content: appImagePath }],
        ownEntryName: "com.t3tools.T3Code.desktop",
        appImagePath,
      }),
    );
    assert.isFalse(
      DesktopLinuxUrlHandler.hasIntegratedLauncherEntry({
        entries: [{ name: "appimagekit_abc123-T3-Code.desktop", content: null }],
        ownEntryName: "com.t3tools.T3Code.desktop",
        appImagePath,
      }),
    );
  });

  it("carries structured context on registration errors", () => {
    const writeError = new DesktopLinuxUrlHandler.DesktopLinuxUrlHandlerRegistrationError({
      step: "write-desktop-entry",
      scheme: "t3code",
      desktopEntryPath: "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
      cause: new Error("boom"),
    });
    assert.equal(
      writeError.message,
      "Failed to register the t3code:// URL handler (step: write-desktop-entry).",
    );
    assert.equal(
      writeError.desktopEntryPath,
      "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
    );

    const exitError = new DesktopLinuxUrlHandler.DesktopLinuxUrlHandlerRegistrationError({
      step: "set-default-handler",
      scheme: "t3code",
      exitCode: 4,
    });
    assert.equal(
      exitError.message,
      "Failed to register the t3code:// URL handler (step: set-default-handler, xdg-mime exit code 4).",
    );
  });

  it.effect("promotes the entry to the launcher when no integrator claimed the AppImage", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded);

      assert.deepEqual(recorded.directories, ["/home/alice/.local/share/applications"]);
      assert.deepEqual(recorded.binaries, []);
      assert.equal(recorded.files.length, 1);
      assert.equal(
        recorded.files[0]?.path,
        "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
      );
      assert.include(
        recorded.files[0]?.content,
        'Exec="/home/alice/Applications/T3-Code.AppImage" --no-sandbox %U',
      );
      assert.include(recorded.files[0]?.content, "NoDisplay=false");
      assert.include(recorded.files[0]?.content, "Icon=com.t3tools.T3Code");
      assert.include(recorded.files[0]?.content, "StartupWMClass=t3code");
      assert.include(recorded.files[0]?.content, "MimeType=x-scheme-handler/t3code;");
      assert.deepEqual(recorded.commands, [
        {
          command: "xdg-mime",
          args: ["default", "com.t3tools.T3Code.desktop", "x-scheme-handler/t3code"],
        },
      ]);
    });
  });

  it.effect("installs the embedded AppImage icon into the user hicolor theme", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        iconBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      });

      assert.equal(recorded.binaries.length, 1);
      assert.equal(
        recorded.binaries[0]?.path,
        "/home/alice/.local/share/icons/hicolor/512x512/apps/com.t3tools.T3Code.png",
      );
      assert.deepEqual(recorded.binaries[0]?.bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      assert.include(
        recorded.directories,
        "/home/alice/.local/share/icons/hicolor/512x512/apps",
      );
      assert.include(recorded.files[0]?.content, "Icon=com.t3tools.T3Code");
    });
  });

  it.effect("does not reinstall the icon when the hicolor copy already exists", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, { iconBytes: new Uint8Array([1]), iconExists: true });

      assert.deepEqual(recorded.binaries, []);
      assert.equal(recorded.files.length, 1);
      assert.include(recorded.files[0]?.content, "Icon=com.t3tools.T3Code");
    });
  });

  it.effect("stays the hidden handler when an integrator entry references the AppImage", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        directoryEntries: ["appimagekit_abc123-T3-Code.desktop", "org.other.App.desktop"],
        entryContents: {
          "appimagekit_abc123-T3-Code.desktop":
            'Exec="/home/alice/Applications/T3-Code.AppImage" %U',
        },
      });

      assert.equal(recorded.files.length, 1);
      assert.include(
        recorded.files[0]?.content,
        'Exec="/home/alice/Applications/T3-Code.AppImage" %U',
      );
      assert.include(recorded.files[0]?.content, "NoDisplay=true");
      assert.notInclude(recorded.files[0]?.content, "Icon=");
      assert.notInclude(recorded.files[0]?.content, "StartupWMClass=");
      assert.deepEqual(recorded.binaries, []);
      assert.deepEqual(recorded.commands, [
        {
          command: "xdg-mime",
          args: ["default", "com.t3tools.T3Code.desktop", "x-scheme-handler/t3code"],
        },
      ]);
    });
  });

  it.effect("falls back to the process executable outside an AppImage", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, { environment: { appImagePath: Option.none() } });

      assert.include(
        recorded.files[0]?.content,
        `Exec=${DesktopLinuxUrlHandler.escapeDesktopEntryExecArgument(process.execPath)} %U`,
      );
      assert.include(recorded.files[0]?.content, "NoDisplay=true");
      assert.deepEqual(recorded.binaries, []);
    });
  });

  it.effect("does not rewrite a launcher entry that already matches", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        existingEntry: DesktopLinuxUrlHandler.renderLauncherDesktopEntry({
          displayName: "T3 Code (Alpha)",
          execTarget: "/home/alice/Applications/T3-Code.AppImage",
          scheme: "t3code",
          iconName: "com.t3tools.T3Code",
          wmClass: "t3code",
          noSandbox: true,
        }),
      });

      assert.deepEqual(recorded.files, []);
      assert.deepEqual(recorded.binaries, []);
      assert.deepEqual(recorded.directories, []);
      assert.equal(recorded.commands.length, 1);
    });
  });

  it.effect("does not rewrite a matching integrator-era handler entry", () => {
    const recorded = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(recorded, {
        existingEntry: DesktopLinuxUrlHandler.renderUrlHandlerDesktopEntry({
          displayName: "T3 Code (Alpha)",
          execTarget: "/home/alice/Applications/T3-Code.AppImage",
          scheme: "t3code",
        }),
        directoryEntries: ["appimagekit_abc123-T3-Code.desktop"],
        entryContents: {
          "appimagekit_abc123-T3-Code.desktop":
            'Exec="/home/alice/Applications/T3-Code.AppImage" %U',
        },
      });

      assert.deepEqual(recorded.files, []);
      assert.deepEqual(recorded.binaries, []);
      assert.deepEqual(recorded.directories, []);
      assert.equal(recorded.commands.length, 1);
    });
  });

  it.effect("writes the portal identity without claiming the URL scheme in development", () => {
    const nonLinux = emptyRecording();
    const unpackaged = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(nonLinux, { environment: { platform: "darwin" } });
      yield* runRegister(unpackaged, {
        environment: {
          isPackaged: false,
          linuxDesktopEntryName: "com.t3tools.T3Code.Development.desktop",
        },
      });

      assert.deepEqual(nonLinux.files, []);
      assert.equal(
        unpackaged.files[0]?.path,
        "/home/alice/.local/share/applications/com.t3tools.T3Code.Development.desktop",
      );
      assert.deepEqual(unpackaged.commands, []);
    });
  });

  it.effect("never fails startup when registration cannot complete", () => {
    const xdgMimeFailed = emptyRecording();
    const writeFailed = emptyRecording();

    return Effect.gen(function* () {
      yield* runRegister(xdgMimeFailed, { xdgMimeExitCode: 1 });
      yield* runRegister(writeFailed, {
        writeError: PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "writeFileString",
          description: "read-only filesystem",
          pathOrDescriptor: "/home/alice/.local/share/applications/com.t3tools.T3Code.desktop",
        }),
      });

      assert.equal(xdgMimeFailed.files.length, 1);
      assert.deepEqual(writeFailed.commands, []);
    });
  });
});
