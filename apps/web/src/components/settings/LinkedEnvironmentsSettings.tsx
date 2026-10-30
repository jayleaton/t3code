import { useAtomValue } from "@effect/atom-react";
import { linkRequestFailureMessage } from "@t3tools/client-runtime/link-request";
import {
  AuthAccessWriteScope,
  AuthMcpClientAccess,
  type EnvironmentId,
  type PeerLinkSummary,
  TAILNET_DEVICE_CAPABILITY,
  type TailnetDevicesSettings,
  type TailnetDevicesUpdateSettingsInput,
} from "@t3tools/contracts";
import {
  isTailnetDevicesForbidden,
  linkedDeviceRows,
} from "@t3tools/client-runtime/tailnet-devices";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { mintPairingCodeOn } from "~/state/peerPairingCode";
import { peerLinkEnvironment, useLinkableMachines } from "~/state/peerLinks";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { tailnetDevices } from "~/state/tailnetDevices";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { accessConfig } from "../auth/ConnectAgentSurface";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { LinkAccessPicker } from "./LinkAccessPicker";
import { LinkedDeviceRow } from "./LinkedDeviceRow";
import { ANOTHER_ADDRESS, LinkMachineSelect } from "./LinkMachineSelect";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useNowMinute } from "../../hooks/useNowMinute";
import { searchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LinkedEnvironmentsSettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const links = useEnvironmentQuery(peerLinkEnvironment.list({ environmentId, input: {} }));
  const devices = useEnvironmentQuery(tailnetDevices.list({ environmentId, input: {} }));
  const canLink = useAtomValue(peerLinkEnvironment.link.permissionAtom(environmentId));
  const { environments } = useEnvironments();
  const search = searchableSetting("linked-environments");
  // Older servers, and this one until it can link devices, fail the list; that is not an error.
  const devicesUnavailable = devices.error !== null && !isTailnetDevicesForbidden(devices.failure);
  const rows = linkedDeviceRows({
    devices: devices.data?.devices ?? [],
    links: links.data?.links ?? [],
    savedEnvironmentIds: new Set(environments.map((environment) => environment.environmentId)),
  });
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={canLink ? <LinkEnvironmentAction environmentId={environmentId} /> : null}
    >
      {devices.data ? (
        <YourDevicesSettings environmentId={environmentId} settings={devices.data.settings} />
      ) : null}
      {links.error ? (
        <SettingsRow title="Could not load linked environments" description={links.error} />
      ) : !links.data ? (
        <SettingsRow title="Loading linked environments…" role="status" />
      ) : rows.length === 0 ? (
        <SettingsRow
          title="No linked environments"
          description="Link another machine running T3 Code, such as a VPS, so agents here can launch and drive threads there."
        />
      ) : (
        rows.map((row) =>
          row.device !== null ? (
            <LinkedDeviceRow
              key={row.environmentId}
              hostEnvironmentId={environmentId}
              row={row}
              device={row.device}
              restoreAccess={devices.data?.settings.defaultAccess ?? "approval-required"}
              forget={
                row.link === null ? null : (
                  <ForgetLinkButton environmentId={environmentId} link={row.link} />
                )
              }
            />
          ) : row.link !== null ? (
            <LinkedEnvironmentRow
              key={row.environmentId}
              environmentId={environmentId}
              link={row.link}
            />
          ) : null,
        )
      )}
      {devicesUnavailable ? (
        <SettingsRow
          title="Your devices"
          description="Not available on this server yet. Update it to see and manage your other machines here."
        />
      ) : null}
    </SettingsSection>
  );
}

/** Settings every one of your devices shares, changed from any of them. */
function YourDevicesSettings({
  environmentId,
  settings,
}: {
  readonly environmentId: EnvironmentId;
  readonly settings: TailnetDevicesSettings;
}) {
  const canUpdate = useAtomValue(tailnetDevices.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(tailnetDevices.updateSettings, {
    label: "update your devices settings",
  });
  const update = (input: TailnetDevicesUpdateSettingsInput) =>
    void updateSettings({ environmentId, input });
  return (
    <>
      <SettingsRow
        title="Link my tailnet devices automatically"
        description="Your other machines on this tailnet, signed in as you, link both ways without a pairing code."
        control={
          <Switch
            checked={settings.autoLink}
            disabled={!canUpdate}
            onCheckedChange={(checked) => update({ autoLink: Boolean(checked) })}
            aria-label="Link my tailnet devices automatically"
          />
        }
      />
      <SettingsRow
        title="Only devices with the T3 capability"
        description={`Count a machine as yours only when your Tailscale policy grants it ${TAILNET_DEVICE_CAPABILITY}.`}
        control={
          <Switch
            checked={settings.requireCapability}
            disabled={!canUpdate}
            onCheckedChange={(checked) => update({ requireCapability: Boolean(checked) })}
            aria-label="Only devices with the T3 capability"
          />
        }
      />
      <SettingsRow
        title="Access for new devices"
        description="What a newly found device may do here until you change it."
        control={
          <Select
            value={settings.defaultAccess}
            disabled={!canUpdate}
            onValueChange={(next) => {
              if (next !== null) update({ defaultAccess: next as AuthMcpClientAccess });
            }}
          >
            <SelectTrigger size="sm" aria-label="Access for new devices">
              <SelectValue>{accessConfig[settings.defaultAccess].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AuthMcpClientAccess.literals.map((option) => (
                <SelectItem key={option} value={option} hideIndicator>
                  {accessConfig[option].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function LinkedEnvironmentRow({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const nowMinute = useNowMinute();
  const health = peerLinkHealth(link, DateTime.makeUnsafe(nowMinute));
  const status =
    health.kind === "expired"
      ? "Expired. Link it again with a new pairing code."
      : health.kind === "unreachable"
        ? (health.detail ?? "Not answering right now.")
        : health.kind === "failing"
          ? health.detail
          : health.expiresInDays !== null
            ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}. Link it again to renew.`
            : "Reachable";
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={status}
              dotClassName={
                health.kind === "reachable"
                  ? health.expiresInDays === null
                    ? "bg-success"
                    : "bg-warning"
                  : health.kind === "expired" || health.kind === "failing"
                    ? "bg-destructive"
                    : "bg-muted-foreground/30"
              }
              pingClassName={null}
            />
            <h3 className="text-sm font-medium text-foreground">{link.label}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {accessConfig[link.access].label} · {status}
          </p>
          <p className="truncate text-xs text-muted-foreground/80">{link.urls.join(", ")}</p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <ForgetLinkButton environmentId={environmentId} link={link} />
        </div>
      </div>
    </div>
  );
}

/** Drops `environmentId`'s link to `link`, after asking. Hidden without permission. */
function ForgetLinkButton({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: PeerLinkSummary;
}) {
  const unlink = useAtomCommand(peerLinkEnvironment.unlink, { label: "unlink environment" });
  const canUnlink = useAtomValue(peerLinkEnvironment.unlink.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Forget ${link.label}? Agents here stop working there. Revoke "T3 Code · …" in ${link.label}'s Environments settings to end the session there too.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await unlink({ environmentId, input: { environmentId: link.environmentId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not forget the link", String(squashAtomCommandFailure(result)));
    }
  };
  if (!canUnlink) return null;
  return (
    <Button size="xs" variant="destructive-outline" disabled={busy} onClick={() => void forget()}>
      {busy ? "Forgetting…" : "Forget"}
    </Button>
  );
}

function LinkEnvironmentAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const machines = useLinkableMachines(environmentId, open);
  // Null until the user picks; with no other machines known, only an address is left.
  const [choice, setChoice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [busy, setBusy] = useState(false);
  // Machines whose minting already failed, so the dialog asks for a code instead.
  const [mintFailed, setMintFailed] = useState<ReadonlySet<EnvironmentId>>(new Set());
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const formId = useId();
  const link = useAtomCommand(peerLinkEnvironment.link, { label: "link environment" });
  const selected = choice ?? (machines.length === 0 ? ANOTHER_ADDRESS : null);
  const machine = machines.find((candidate) => candidate.environmentId === selected) ?? null;
  // This client can mint a code there when it is connected to that
  // environment with a session that may create pairing links.
  const targetId = machine?.environmentId ?? null;
  const connected = usePreparedConnection(targetId);
  const mayMint = useEnvironmentScope(targetId, AuthAccessWriteScope);
  const canMint =
    targetId !== null && Option.isSome(connected) && mayMint && !mintFailed.has(targetId);
  const needsAddress = selected === ANOTHER_ADDRESS || machine?.urls.length === 0;
  const ready =
    selected !== null &&
    (!needsAddress || address.trim().length > 0) &&
    (canMint || pairingCode.trim().length > 0);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChoice(null);
      setAddress("");
      setPairingCode("");
      setAccess("approval-required");
      setMintFailed(new Set());
    }
  };
  // Settles to the code to link with, or null after reporting why there is none.
  const resolvePairingCode = async () => {
    if (!canMint || targetId === null) return pairingCode.trim();
    const minted = await mintPairingCodeOn(targetId, access);
    if (Result.isSuccess(minted)) return minted.success;
    setMintFailed((failed) => new Set(failed).add(targetId));
    failureToast("Could not link the environment", linkRequestFailureMessage(minted.failure));
    return null;
  };
  const submit = async () => {
    const [url, ...alternateUrls] =
      machine === null || needsAddress ? [address.trim()] : machine.urls;
    if (inFlight.current || !ready || url === undefined) return;
    inFlight.current = true;
    setBusy(true);
    const code = await resolvePairingCode();
    const result =
      code === null
        ? null
        : await link({
            environmentId,
            input: {
              url,
              ...(alternateUrls.length > 0 ? { alternateUrls } : {}),
              ...(machine === null
                ? {}
                : { expectedEnvironmentId: machine.environmentId, expectedLabel: machine.label }),
              pairingCode: code,
              access,
            },
          });
    inFlight.current = false;
    setBusy(false);
    if (result === null) return;
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Linked ${result.value.label}` });
      handleOpenChange(false);
    } else if (!isAtomCommandInterrupted(result)) {
      failureToast("Could not link the environment", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        handleOpenChange(next);
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Link
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link an environment</DialogTitle>
          <DialogDescription>
            Agents here can then launch, message and wait on threads there. It appears in that
            environment's Connections, where it can be revoked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-4"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {machines.length > 0 ? (
              <LinkMachineSelect
                machines={machines}
                value={selected}
                disabled={busy}
                onChange={setChoice}
              />
            ) : null}
            {machine?.linked ? (
              <p className="text-xs text-muted-foreground">
                Already linked. Linking again renews it with the access you pick.
              </p>
            ) : null}
            {needsAddress ? (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Address</span>
                <Input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    // Machines found after typing began must not hide the address being typed.
                    if (choice === null) setChoice(ANOTHER_ADDRESS);
                  }}
                  placeholder="https://box.example.ts.net"
                  disabled={busy}
                  autoFocus={machines.length === 0}
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    This app has no address for {machine.label} that another machine can reach.
                    Enter its https or Tailscale address.
                  </span>
                ) : null}
              </label>
            ) : null}
            {selected === null || canMint ? null : (
              <label className="block space-y-1.5">
                <span className="block text-xs font-medium text-foreground">Pairing code</span>
                <Input
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value)}
                  placeholder={
                    machine === null
                      ? "From that environment's Connections, or t3 pair there"
                      : "Paste the code"
                  }
                  disabled={busy}
                  autoComplete="one-time-code"
                  nativeInput
                  spellCheck={false}
                />
                {machine !== null ? (
                  <span className="block text-xs text-muted-foreground">
                    Create a link on {machine.label}: Settings → Connections → Create link, then
                    paste its code here.
                  </span>
                ) : null}
              </label>
            )}
            <LinkAccessPicker value={access} onChange={setAccess} disabled={busy} />
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose disabled={busy} render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button form={formId} type="submit" disabled={busy || !ready}>
            {busy ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
