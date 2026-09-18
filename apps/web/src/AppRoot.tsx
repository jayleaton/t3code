import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { McpGatewayHost } from "./McpGatewayHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { VoiceAssistantHostProvider } from "./voice-assistant/VoiceAssistantHost";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <VoiceAssistantHostProvider>
        <RouterProvider router={router} />
        <McpGatewayHost router={router} />
        <PreviewAutomationHosts />
        <ElectronBrowserHost />
        <QuitHoldOverlay />
      </VoiceAssistantHostProvider>
    </AppAtomRegistryProvider>
  );
}
