import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { isLocalVoiceHost, selectVoiceDevice } from "./localDevice";

export function useVoiceDevice() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primaryIsLocal = isLocalVoiceHost({
    desktop: window.desktopBridge !== undefined,
    localEnabled: window.desktopBridge?.getLocalEnvironmentEnabled?.() !== false,
    hostname: window.location.hostname,
  });
  const candidates = environments.map((env) => ({
    id: env.environmentId,
    url: env.displayUrl,
    direct:
      env.entry.target._tag === "BearerConnectionTarget" ||
      env.entry.target._tag === "PrimaryConnectionTarget",
    connected: env.connection.phase === "connected",
    supported: env.serverConfig?.environment.capabilities.voiceExecution === true,
  }));
  if (primaryIsLocal && candidates.some((c) => c.id === primary && c.connected && c.supported))
    return primary;
  return selectVoiceDevice(candidates);
}
