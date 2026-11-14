import type { Notification, NotificationBehavior } from "expo-notifications";

import { notificationThreadPath } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export function foregroundNotificationBehavior(
  notification: Notification,
  threadPathOnScreen: string | null,
): NotificationBehavior {
  const target = notificationThreadPath({ notification });
  return target !== null && target === threadPathOnScreen ? SUPPRESS : SHOW;
}
