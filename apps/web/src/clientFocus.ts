import {
  makeClientFocusDispatcher,
  makeClientFocusLayer,
} from "@t3tools/client-runtime/client-focus";
import {
  EnvironmentId,
  ThreadId,
  type ClientFocusRequest,
  type DesktopBridge,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { clientFocusIdentity } from "./connection/clientMetadata";
import { getClientId } from "./lib/backgroundActivityReporter";
import { useRightPanelStore } from "./rightPanelStore";
import type { AppRouter } from "./router";

const dispatcher = makeClientFocusDispatcher();
export const setClientFocusHandler = dispatcher.setHandler;

export const clientFocusLayer = makeClientFocusLayer({
  host: Effect.sync(() =>
    typeof window === "undefined"
      ? null
      : {
          clientId: getClientId(),
          clientKind: window.desktopBridge ? "desktop-renderer" : "web",
          ...clientFocusIdentity({
            identity: {
              userAgent: navigator.userAgent,
              platform: navigator.platform,
              maxTouchPoints: navigator.maxTouchPoints,
            },
            desktopBridge: window.desktopBridge,
          }),
        },
  ),
  onRequest: dispatcher.onRequest,
});

/** Shows what an agent asked for and brings the window forward where the platform allows. */
export async function applyClientFocusRequest(
  router: Pick<AppRouter, "navigate">,
  desktop: Pick<DesktopBridge, "revealWindow"> | undefined,
  environmentId: EnvironmentId,
  request: ClientFocusRequest,
): Promise<void> {
  const target = request.target;
  if (target._tag === "agents") {
    await router.navigate({ to: "/agents" });
  } else {
    const threadId = ThreadId.make(target.threadId);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make(environmentId), threadId },
    });
    if (target._tag === "file") {
      useRightPanelStore.getState().openFile({ environmentId, threadId }, target.path, target.line);
    }
  }
  if (desktop?.revealWindow) {
    await desktop.revealWindow();
  } else {
    window.focus();
  }
}
