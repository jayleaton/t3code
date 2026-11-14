import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

const router = startAppServices();

let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

export const startup = router
  .load()
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  .then(whenLocaleReady)
  .then(() => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <AppRoot router={router} />
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
