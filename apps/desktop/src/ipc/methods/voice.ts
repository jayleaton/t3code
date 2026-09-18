import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { startMacVoiceShortcut } from "../../voice/MacVoiceShortcut.ts";
import { VOICE_SHORTCUT_CONFIGURE, VOICE_SHORTCUT_EVENT } from "../channels.ts";

class VoiceShortcutError extends Schema.TaggedError<VoiceShortcutError>()("VoiceShortcutError", {
  message: Schema.String,
}) {}

export const installVoiceShortcut = Effect.fn("desktop.ipc.installVoiceShortcut")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const windows = yield* ElectronWindow.ElectronWindow;
  const platform = yield* HostProcessPlatform;
  let stop: (() => void) | undefined;
  let revision = 0;
  const clear = () => {
    revision += 1;
    stop?.();
    stop = undefined;
  };
  yield* Effect.addFinalizer(() => Effect.sync(clear));
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: VOICE_SHORTCUT_CONFIGURE,
      payload: Schema.NullOr(Schema.String),
      result: Schema.Struct({ registered: Schema.Boolean, message: Schema.String }),
      handler: Effect.fn("desktop.ipc.configureVoiceShortcut")(function* (value, event) {
        const main = yield* windows.main;
        if (Option.isNone(main) || main.value.webContents.id !== event?.sender.id) {
          return { registered: false, message: "Voice shortcut request rejected." };
        }
        clear();
        if (!value) return { registered: false, message: "Global voice shortcut disabled." };
        if (platform !== "darwin")
          return {
            registered: false,
            message:
              "Global hold-to-talk is currently available on macOS. Use the in-app shortcut here.",
          };
        if (!Electron.systemPreferences.isTrustedAccessibilityClient(false)) {
          return {
            registered: false,
            message:
              "Enable Accessibility for T3 in macOS System Settings to use voice from other apps. The in-app shortcut still works.",
          };
        }
        const current = revision;
        const sender = main.value.webContents;
        return yield* Effect.tryPromise({
          try: async () => {
            const release = await startMacVoiceShortcut(value, (phase) => {
              if (current === revision && !sender.isDestroyed())
                sender.send(VOICE_SHORTCUT_EVENT, phase);
            });
            if (current !== revision) {
              release();
              return { registered: false, message: "Shortcut changed." };
            }
            stop = () => {
              sender.removeListener("destroyed", clear);
              sender.removeListener("did-start-loading", clear);
              release();
            };
            sender.once("destroyed", clear);
            sender.once("did-start-loading", clear);
            return { registered: true, message: "Hold the shortcut from any app to talk." };
          },
          catch: (cause) => new VoiceShortcutError({ message: String(cause) }),
        }).pipe(
          Effect.catch((cause) => Effect.succeed({ registered: false, message: cause.message })),
        );
      }),
    }),
  );
});
