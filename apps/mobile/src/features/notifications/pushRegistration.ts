import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { subscribeAppActive } from "../../lib/appState";
import { MOBILE_APP_NAME } from "../../lib/mobileBranding";
import { loadOrCreateInstallId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { notificationPermissionAtom } from "./notificationPermission";
import { pushRegistrationAction, type PushRegistrationAction } from "./pushRegistrationAction";

const UNREGISTER_BEFORE_REMOVAL_TIMEOUT_MS = 3_000;

const registerPushToken = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push-registration:register",
  tag: WS_METHODS.pushRegistrationsRegister,
});

const unregisterPushToken = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "push-registration:unregister",
  tag: WS_METHODS.pushRegistrationsUnregister,
});

export function environmentSupportsPush(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .pushNotifications === true
  );
}

/** What each connected server should hear from this phone right now. */
const pushActionsAtom = Atom.make((get) => {
  const actions = new Map<EnvironmentId, PushRegistrationAction>();
  const preferences = get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences)) return actions;
  const off = new Set(preferences.value.pushNotificationsOffEnvironmentIds ?? []);
  const permission = get(notificationPermissionAtom);
  for (const environmentId of get(connectedEnvironmentIdsAtom)) {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    actions.set(
      environmentId,
      pushRegistrationAction({
        platform: Platform.OS,
        permission,
        enabled: !off.has(environmentId),
        supportsPush: config?.environment.capabilities.pushNotifications === true,
        connected: true,
      }),
    );
  }
  return actions;
}).pipe(Atom.withLabel("mobile:push-registration-actions"));

let expoPushToken: Promise<string> | null = null;

function loadExpoPushToken(): Promise<string> {
  expoPushToken ??= Notifications.getExpoPushTokenAsync({
    projectId: Constants.expoConfig?.extra?.eas?.projectId,
  }).then(
    (token) => token.data,
    (cause: unknown) => {
      expoPushToken = null;
      throw cause;
    },
  );
  return expoPushToken;
}

function deviceLabel(): string {
  return (Device.deviceName?.trim() || Device.modelName?.trim() || MOBILE_APP_NAME).slice(0, 128);
}

async function sendPushRegistration(
  environmentId: EnvironmentId,
  action: Exclude<PushRegistrationAction, "none">,
): Promise<boolean> {
  const installId = await loadOrCreateInstallId();
  const result =
    action === "unregister"
      ? await runAtomCommand(appAtomRegistry, unregisterPushToken, {
          environmentId,
          input: { installId },
        })
      : await runAtomCommand(appAtomRegistry, registerPushToken, {
          environmentId,
          input: { installId, expoPushToken: await loadExpoPushToken(), label: deviceLabel() },
        });
  return AsyncResult.isSuccess(result);
}

/**
 * Keeps each connected server's copy of this phone's push token current. Servers
 * drop a registration when its session ends, so every connect and every return to
 * the foreground registers again. iOS only for now.
 */
export function installPushRegistration(): () => void {
  if (Platform.OS !== "ios") return () => {};
  // The action last sent per server; a server that disconnects is forgotten so a reconnect resends.
  const sent = new Map<EnvironmentId, PushRegistrationAction>();
  const queues = new Map<EnvironmentId, Promise<void>>();

  const enqueue = (
    environmentId: EnvironmentId,
    action: Exclude<PushRegistrationAction, "none">,
  ) => {
    const previous = queues.get(environmentId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const succeeded = await sendPushRegistration(environmentId, action).catch(
        (cause: unknown) => {
          console.warn("[push-registration] could not update this server", cause);
          return false;
        },
      );
      if (!succeeded && sent.get(environmentId) === action) sent.delete(environmentId);
    });
    queues.set(environmentId, next);
    void next.finally(() => {
      if (queues.get(environmentId) === next) queues.delete(environmentId);
    });
  };

  const apply = (resend: boolean) => {
    const actions = appAtomRegistry.get(pushActionsAtom);
    for (const environmentId of sent.keys()) {
      if (!actions.has(environmentId)) sent.delete(environmentId);
    }
    for (const [environmentId, action] of actions) {
      if (!resend && sent.get(environmentId) === action) continue;
      sent.set(environmentId, action);
      if (action !== "none") enqueue(environmentId, action);
    }
  };

  const unsubscribe = appAtomRegistry.subscribe(pushActionsAtom, () => apply(false), {
    immediate: true,
  });
  const unsubscribeActive = subscribeAppActive(() => apply(true));
  const tokenSubscription = Notifications.addPushTokenListener(() => {
    expoPushToken = null;
    apply(true);
  });
  return () => {
    unsubscribe();
    unsubscribeActive();
    tokenSubscription.remove();
  };
}

/** Best effort: removal goes ahead after a short wait when the server cannot be reached. */
export async function unregisterPushBeforeRemoval(environmentId: EnvironmentId): Promise<void> {
  if (Platform.OS !== "ios" || !environmentSupportsPush(environmentId)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unregister = loadOrCreateInstallId()
    .then((installId) =>
      runAtomCommand(
        appAtomRegistry,
        unregisterPushToken,
        { environmentId, input: { installId } },
        { reportFailure: false },
      ),
    )
    .catch(() => undefined);
  await Promise.race([
    unregister,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, UNREGISTER_BEFORE_REMOVAL_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}
