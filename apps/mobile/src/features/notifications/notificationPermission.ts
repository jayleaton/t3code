import * as Notifications from "expo-notifications";

import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import type { NotificationPermission } from "./pushRegistrationAction";

function toNotificationPermission(
  response: Notifications.NotificationPermissionsStatus,
): NotificationPermission {
  if (response.granted) return "granted";
  return response.canAskAgain ? "ask" : "denied";
}

const readNotificationPermission = () =>
  Notifications.getPermissionsAsync().then(
    toNotificationPermission,
    (): NotificationPermission => "ask",
  );

export const notificationPermissionAtom = makePermissionStatusAtom<NotificationPermission>({
  label: "mobile:notification-permission",
  initial: "checking",
  read: readNotificationPermission,
});

export const requestNotificationPermission = (): Promise<NotificationPermission> =>
  Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  }).then(toNotificationPermission, readNotificationPermission);
