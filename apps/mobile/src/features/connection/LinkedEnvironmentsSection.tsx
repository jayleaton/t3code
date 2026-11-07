import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import {
  isTailnetDevicesForbidden,
  linkedDeviceRows,
} from "@t3tools/client-runtime/tailnet-devices";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import { useFocusEffect } from "@react-navigation/native";
import {
  AuthAccessReadScope,
  type AuthMcpClientAccess,
  type EnvironmentId,
  type TailnetDevice,
  type TailnetDeviceAccess,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useCallback, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { tailnetDevices } from "../../state/tailnetDevices";
import { useAtomCommand } from "../../state/use-atom-command";
import { ACCESS_CHOICES } from "../threads/thread-settings-options";
import { SettingsSection } from "../settings/components/SettingsSection";

export function LinkedEnvironmentsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const canRead = useEnvironmentScope(props.environmentId, AuthAccessReadScope);
  const supported = canRead && offersLinkedEnvironments(config);
  const links = useEnvironmentQuery(
    supported ? peerLinkEnvironment.list({ environmentId: props.environmentId, input: {} }) : null,
  );
  const devices = useEnvironmentQuery(
    supported ? tailnetDevices.list({ environmentId: props.environmentId, input: {} }) : null,
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const hasLinks = supported && (links.data?.links.length ?? 0) > 0;
  useFocusEffect(
    useCallback(() => {
      if (!hasLinks) return;
      const updateNow = () => setNowMs(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, [hasLinks]),
  );
  if (!supported || links.error || !links.data) return null;
  const rows = linkedDeviceRows({
    devices: devices.data?.devices ?? [],
    links: links.data.links,
    savedEnvironmentIds: new Set(),
  });
  if (rows.length === 0) return null;
  // Older servers, and this one until it can link devices, fail the list; that is not an error.
  const devicesUnavailable = devices.error !== null && !isTailnetDevicesForbidden(devices.failure);
  const now = DateTime.makeUnsafe(nowMs);
  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={`Linked from ${props.environmentLabel}`}>
        {rows.map(({ device, link }) => {
          if (device !== null) {
            return (
              <DeviceRow
                key={device.environmentId}
                hostEnvironmentId={props.environmentId}
                device={device}
                restoreAccess={devices.data?.settings.defaultAccess ?? "approval-required"}
              />
            );
          }
          if (link === null) return null;
          const health = peerLinkHealth(link, now);
          const status =
            health.kind === "expired"
              ? "Expired. Link it again with a new pairing code."
              : health.kind === "unreachable"
                ? (health.detail ?? "Not answering right now.")
                : health.kind === "failing"
                  ? health.detail
                  : health.expiresInDays !== null
                    ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}`
                    : "Reachable";
          return (
            <View key={link.environmentId} className="gap-0.5 p-4">
              <Text className="text-base font-t3-bold text-foreground">{link.label}</Text>
              <Text
                className={
                  health.kind === "reachable" && health.expiresInDays === null
                    ? "text-xs text-foreground-muted"
                    : "text-xs text-danger-foreground"
                }
                numberOfLines={2}
              >
                {status}
              </Text>
            </View>
          );
        })}
      </SettingsSection>
      {devicesUnavailable ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Your devices are not available on this server yet.
        </Text>
      ) : null}
    </View>
  );
}

const DEVICE_STATUS: Record<TailnetDevice["status"], string> = {
  online: "Online",
  offline: "Offline",
  revoked: "Revoked",
};

/** One of your devices, with its access on the host; Revoked is one of the choices. */
function DeviceRow(props: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly device: TailnetDevice;
  readonly restoreAccess: AuthMcpClientAccess;
}) {
  const { device } = props;
  const canSetAccess = useAtomValue(
    tailnetDevices.setAccess.permissionAtom(props.hostEnvironmentId),
  );
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const revoked = device.access === "revoked";
  const accessLabel = revoked
    ? "Revoked"
    : (ACCESS_CHOICES.find((choice) => choice.access === device.access)?.label ?? device.access);
  const save = (access: TailnetDeviceAccess) => {
    setSaving(true);
    void setAccess({
      environmentId: props.hostEnvironmentId,
      input: { environmentId: device.environmentId, access },
    }).then((result) => {
      setSaving(false);
      if (result._tag === "Failure") {
        Dialog.alert(`Could not change ${device.label}'s access`, "Try again in a moment.");
      } else {
        setExpanded(false);
      }
    });
  };
  const choose = (access: TailnetDeviceAccess) => {
    if (access === device.access) return;
    if (access !== "revoked") return save(access);
    Dialog.confirm({
      title: `Revoke ${device.label}?`,
      message: "It loses access on every one of your devices until someone restores it.",
      confirmText: "Revoke",
      destructive: true,
      onConfirm: () => save("revoked"),
    });
  };
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${device.label} access`}
        accessibilityState={{ expanded, disabled: !canSetAccess }}
        disabled={!canSetAccess}
        className="flex-row items-center gap-3 p-4"
        onPress={() => setExpanded((open) => !open)}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-bold text-foreground">{device.label}</Text>
          <Text
            className={revoked ? "text-xs text-danger-foreground" : "text-xs text-foreground-muted"}
            numberOfLines={1}
          >
            {[
              device.outgoing === "paired" ? "Paired" : "Tailnet",
              DEVICE_STATUS[device.status],
            ].join(" · ")}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted">{accessLabel}</Text>
        {canSetAccess ? (
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        ) : null}
      </Pressable>
      {expanded ? (
        <>
          {ACCESS_CHOICES.map((choice) => (
            <ListChoiceRow
              key={choice.access}
              label={
                revoked && choice.access === props.restoreAccess
                  ? `Restore as ${choice.label}`
                  : choice.label
              }
              description={choice.description}
              selected={device.access === choice.access}
              disabled={saving}
              onPress={() => choose(choice.access)}
            />
          ))}
          <ListChoiceRow
            label="Revoked"
            description="No access on any of your devices until someone restores it."
            selected={revoked}
            disabled={saving}
            onPress={() => choose("revoked")}
          />
        </>
      ) : null}
    </View>
  );
}
