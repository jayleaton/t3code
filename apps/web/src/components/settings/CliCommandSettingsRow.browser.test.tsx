import { RegistryContext } from "@effect/atom-react";
import type { DesktopCliCommandState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { desktopCliCommandStateAtom } from "../../state/desktopCliCommand";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";

it("blocks installation behind another t3 without blocking removal of our installation", async () => {
  const state: DesktopCliCommandState = {
    supported: true,
    installedPath: null,
    onPath: false,
    launcherPath: "/home/test/.t3/bin/t3",
  };
  const getState = vi.fn(async (): Promise<DesktopCliCommandState> => ({
    ...state,
    shadowedBy: "/usr/local/bin/t3",
  }));
  const uninstall = vi.fn(async () => state);
  using _bridge = stubGlobal("desktopBridge", {
    cliCommand: { getState, install: vi.fn(async () => state), uninstall },
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <CliCommandSettingsRow />
    </RegistryContext.Provider>,
  );

  await expect.element(screen.getByRole("button", { name: "Install" })).toBeDisabled();

  getState.mockResolvedValue(state);
  await act(() => registry.refresh(desktopCliCommandStateAtom));
  await expect.element(screen.getByRole("button", { name: "Install" })).toBeEnabled();

  getState.mockResolvedValue({
    ...state,
    installedPath: "/home/test/.local/bin/t3",
    shadowedBy: "/usr/local/bin/t3",
  });
  await act(() => registry.refresh(desktopCliCommandStateAtom));
  const remove = screen.getByRole("button", { name: "Remove" });
  await expect.element(remove).toBeEnabled();
  await remove.click();
  expect(uninstall).toHaveBeenCalledOnce();
});

it("names the command that runs the installation", async () => {
  const state: DesktopCliCommandState = {
    supported: true,
    installedPath: "/home/test/.local/bin/t3",
    onPath: true,
    launcherPath: "/home/test/.t3/bin/t3",
  };
  const getState = vi.fn(async (): Promise<DesktopCliCommandState> => ({
    ...state,
    command: "t3",
    aliasBlockedBy: "/home/test/.local/bin/ada",
  }));
  using _bridge = stubGlobal("desktopBridge", {
    cliCommand: { getState },
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <CliCommandSettingsRow />
    </RegistryContext.Provider>,
  );

  const described = (text: string) => expect.element(screen.getByText(text)).toBeVisible();
  await described(
    "Installed at /home/test/.local/bin/t3. Another ada at /home/test/.local/bin/ada was left in place. Open a new terminal and run `t3`.",
  );

  // A desktop build from before the alias reports no command and links only t3.
  getState.mockResolvedValue(state);
  await act(() => registry.refresh(desktopCliCommandStateAtom));
  await described("Installed at /home/test/.local/bin/t3. Open a new terminal and run `t3`.");

  getState.mockResolvedValue({ ...state, command: "ada" });
  await act(() => registry.refresh(desktopCliCommandStateAtom));
  await described("Installed at /home/test/.local/bin/t3. Open a new terminal and run `ada`.");
});
