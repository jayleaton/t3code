import { useAtomValue } from "@effect/atom-react";
import type { LinkedDeviceRow as LinkedDeviceRowModel } from "@t3tools/client-runtime/tailnet-devices";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthMcpClientAccess,
  type EnvironmentId,
  type TailnetDevice,
  type TailnetDeviceAccess,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { connectPairing } from "~/connection/onboarding";
import { requestConfirmDialog } from "~/confirmDialog";
import { tailnetDevices } from "~/state/tailnetDevices";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";

const failureToast = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );

const STATUS_DOT: Record<TailnetDevice["status"], string> = {
  online: "bg-success",
  offline: "bg-muted-foreground/30",
  revoked: "bg-destructive",
};

/** One of your devices as `hostEnvironmentId` sees it: its access there, and opening it here. */
export function LinkedDeviceRow({
  hostEnvironmentId,
  row,
  device,
  restoreAccess,
  forget,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly row: LinkedDeviceRowModel;
  readonly device: TailnetDevice;
  /** What Restore gives back: the default access for new devices. */
  readonly restoreAccess: AuthMcpClientAccess;
  /** Drops this environment's paired link to the device, when it has one. */
  readonly forget: ReactNode;
}) {
  const canSetAccess = useAtomValue(tailnetDevices.setAccess.permissionAtom(hostEnvironmentId));
  const canOpen = useAtomValue(tailnetDevices.openDevice.permissionAtom(hostEnvironmentId));
  const setAccess = useAtomCommand(tailnetDevices.setAccess, { reportFailure: false });
  const openDevice = useAtomCommand(tailnetDevices.openDevice, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const revoked = device.access === "revoked";
  const linkedVia = (device.outgoing ?? row.link?.origin) === "paired" ? "Paired" : "Tailnet";

  const changeAccess = async (access: TailnetDeviceAccess) => {
    if (access === device.access) return;
    if (access === "revoked") {
      const confirmed = await (requestConfirmDialog(
        `Revoke ${device.label}? It loses access on every one of your devices until someone restores it.`,
        { variant: "destructive" },
      ) ?? Promise.resolve(false));
      if (!confirmed) return;
    }
    setBusy(true);
    const result = await setAccess({
      environmentId: hostEnvironmentId,
      input: { environmentId: device.environmentId, access },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast(`Could not change ${device.label}'s access`, result);
    }
  };

  // The credential is one-time, so the first address that pairs uses it up.
  const open = async () => {
    setBusy(true);
    const minted = await openDevice({
      environmentId: hostEnvironmentId,
      input: { environmentId: device.environmentId },
    });
    if (minted._tag === "Failure") {
      setBusy(false);
      if (!isAtomCommandInterrupted(minted)) failureToast(`Could not open ${device.label}`, minted);
      return;
    }
    const { credential, urls, environmentId } = minted.value;
    let last: Awaited<ReturnType<typeof connect>> | null = null;
    for (const host of urls) {
      last = await connect({ host, pairingCode: credential, expectedEnvironmentId: environmentId });
      if (last._tag === "Success") break;
    }
    setBusy(false);
    if (last?._tag === "Success") {
      toastManager.add({ type: "success", title: `Added ${device.label} to this app` });
    } else if (last !== null && !isAtomCommandInterrupted(last)) {
      failureToast(`Could not open ${device.label}`, last);
    } else if (last === null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not open ${device.label}`,
          description: "It reported no address this app can reach.",
        }),
      );
    }
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={revoked ? "Revoked" : device.status === "online" ? "Online" : "Offline"}
              dotClassName={STATUS_DOT[device.status]}
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{row.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {[
              linkedVia,
              revoked ? "Revoked" : device.status === "online" ? "Online" : "Offline",
              row.savedInApp ? "In this app" : null,
              device.tailnetName,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {revoked ? null : (
            <Select
              value={device.access}
              disabled={!canSetAccess || busy}
              onValueChange={(next) => {
                if (next !== null) void changeAccess(next as TailnetDeviceAccess);
              }}
            >
              <SelectTrigger size="sm" aria-label={`${device.label} access`}>
                <SelectValue>{accessConfig[device.access].label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {AuthMcpClientAccess.literals.map((option) => (
                  <SelectItem key={option} value={option} hideIndicator>
                    {accessConfig[option].label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          {!row.savedInApp && !revoked && canOpen ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void open()}>
              Open
            </Button>
          ) : null}
          {canSetAccess ? (
            revoked ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void changeAccess(restoreAccess)}
              >
                Restore
              </Button>
            ) : (
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => void changeAccess("revoked")}
              >
                Revoke
              </Button>
            )
          ) : null}
          {forget}
        </div>
      </div>
    </div>
  );
}
