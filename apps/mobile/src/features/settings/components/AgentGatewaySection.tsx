import { useAtomValue } from "@effect/atom-react";
import { agentGatewayStatusLabel } from "@t3tools/client-runtime/gateway";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";

import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/** Each server's own T3 Agents gateway, which runs there without the desktop app. */
export function AgentGatewaySection({ targets }: { readonly targets: readonly SettingsTarget[] }) {
  const supported = targets.filter(
    (target) => target.serverConfig.environment.capabilities.agentGateway === true,
  );
  if (supported.length === 0) return null;
  return (
    <SettingsSection
      title="Agent gateway"
      footer="Lets MCP hosts on the server's machine drive it with the access set in web or desktop Settings, and keeps T3 Agents webhooks running without the desktop app."
    >
      {supported.map((target, index) => (
        <View
          key={target.environmentId}
          className={index > 0 ? "border-t border-border-subtle" : ""}
        >
          <AgentGatewayRow target={target} />
        </View>
      ))}
    </SettingsSection>
  );
}

function AgentGatewayRow({ target }: { readonly target: SettingsTarget }) {
  const environmentId = target.environmentId;
  const status = useEnvironmentQuery(
    serverEnvironment.agentGateway({ environmentId, input: {} }),
  ).data;
  const allowed = useAtomValue(serverEnvironment.updateAgentGateway.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateAgentGateway, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subtitle =
    error ??
    (status === null
      ? "Loading…"
      : `${agentGatewayStatusLabel(status)}${status.problem ? `. ${status.problem}` : ""}`);
  return (
    <SettingsSwitchRow
      icon="point.3.connected.trianglepath.dotted"
      label={target.label}
      subtitle={subtitle}
      value={status?.enabled ?? false}
      disabled={!allowed || pending || status === null || status.host === "desktop"}
      onValueChange={async (enabled) => {
        setPending(true);
        setError(null);
        const result = await update({ environmentId, input: { enabled } });
        setPending(false);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not change the gateway.");
      }}
    />
  );
}
