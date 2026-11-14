/** "ask" means iOS has not asked yet; after a denial iOS never asks again. */
export type NotificationPermission = "checking" | "granted" | "ask" | "denied";

export type PushRegistrationAction = "register" | "unregister" | "none";

/** What this phone should tell one server about its push token. */
export function pushRegistrationAction(input: {
  readonly platform: string;
  readonly permission: NotificationPermission;
  readonly enabled: boolean;
  readonly supportsPush: boolean;
  readonly connected: boolean;
}): PushRegistrationAction {
  if (input.platform !== "ios" || !input.connected || !input.supportsPush) return "none";
  if (input.permission === "denied" || (input.permission === "granted" && !input.enabled)) {
    return "unregister";
  }
  return input.permission === "granted" ? "register" : "none";
}
