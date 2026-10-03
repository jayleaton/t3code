import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { EllipsisIcon, PencilIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { EnvironmentIconMenu, useEnvironmentOperateAccess } from "./EnvironmentIconPicker";

export function EnvironmentActionsMenu({
  environmentId,
  label,
  serverConfig,
  disabled = false,
  children,
}: {
  environmentId: EnvironmentId;
  label: string;
  serverConfig: ServerConfig | null;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = useEnvironmentOperateAccess(environmentId);
  const persist = useAtomCommand(serverEnvironment.updateSettings, "machine name update");
  const lock =
    serverConfig === null
      ? "Connect to this machine to rename it."
      : !serverConfig.environment.capabilities.environmentLabel
        ? "Update this machine's server to rename it."
        : access !== "granted"
          ? "Your session cannot change this machine's settings."
          : null;
  const save = async (environmentLabel: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const result = await persist({ environmentId, input: { patch: { environmentLabel } } });
      if (result._tag === "Success") setOpen(false);
      else setError("Could not save the machine name. Try again.");
    } catch {
      setError("Could not save the machine name. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              disabled={disabled}
              aria-label={`More actions for ${label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem
            disabled={lock !== null}
            title={lock ?? undefined}
            onClick={() => {
              setName(label);
              setError(null);
              setOpen(true);
            }}
          >
            <PencilIcon /> Rename machine…
          </MenuItem>
          <EnvironmentIconMenu environmentId={environmentId} serverConfig={serverConfig} />
          {children}
        </MenuPopup>
      </Menu>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
      >
        <DialogPopup className="max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && !saving && !lock) void save(name.trim());
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename machine</DialogTitle>
              <DialogDescription>
                This name is saved on the machine and shown on connected devices.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-3">
              <label className="text-sm">
                Machine name
                <Input
                  autoFocus
                  value={name}
                  maxLength={80}
                  disabled={saving}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {lock && (
                <p role="alert" className="text-sm text-muted-foreground">
                  {lock}
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={saving || !!lock || !serverConfig?.settings.environmentLabel}
                onClick={() => void save(null)}
              >
                Reset name
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !!lock || !name.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
