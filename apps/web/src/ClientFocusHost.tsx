import { useEffect } from "react";

import { applyClientFocusRequest, setClientFocusHandler } from "./clientFocus";
import type { AppRouter } from "./router";

/** Lets agents bring threads and files on screen in this window. */
export function ClientFocusHost({ router }: { readonly router: AppRouter }) {
  useEffect(() => {
    setClientFocusHandler((environmentId, request) =>
      applyClientFocusRequest(router, window.desktopBridge, environmentId, request),
    );
    return () => setClientFocusHandler(null);
  }, [router]);
  return null;
}
