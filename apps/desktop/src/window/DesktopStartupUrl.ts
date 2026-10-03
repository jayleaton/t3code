import { getDesktopUrl } from "../electron/ElectronProtocol.ts";

declare const __T3CODE_DESKTOP_BRAND__: string | undefined;

export function getDesktopStartupUrl(
  isDevelopment: boolean,
  brand = typeof __T3CODE_DESKTOP_BRAND__ === "undefined" ? "t3" : __T3CODE_DESKTOP_BRAND__,
): string {
  const url = getDesktopUrl(isDevelopment);
  return brand === "agents" ? `${url}#/agents` : url;
}
