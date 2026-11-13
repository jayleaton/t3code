import { LICENSE_URL } from "@t3tools/shared/cliRelease";

import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";

export function SettingsLegalRouteScreen() {
  return <SettingsLegalDocumentRouteScreen documentName="License" documentUrl={LICENSE_URL} />;
}
