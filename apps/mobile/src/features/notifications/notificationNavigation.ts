import * as Notifications from "expo-notifications";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeNotificationResponseOnce, threadPathOnScreen } from "./notificationPayload";
import { consumeLastNotificationResponse } from "./notificationResponseConsumer";

let currentThreadPath: string | null = null;

/** Called with the workspace pathname on every root navigation state change. */
export function setNotificationPathname(pathname: string): void {
  currentThreadPath = threadPathOnScreen(pathname);
}

/**
 * App-lifetime notification routing: a push for the thread already on screen stays
 * quiet, and taps (including the cold-start tap) open its thread through `navigate`.
 */
export function installNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, currentThreadPath)),
  });

  const handleResponse = (response: Notifications.NotificationResponse): void => {
    routeNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
