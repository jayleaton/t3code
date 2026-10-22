import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({ persist: vi.fn(), access: "granted" }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("./EnvironmentIconPicker", () => ({
  EnvironmentIconMenu: () => null,
  useEnvironmentOperateAccess: () => state.access,
}));

import { EnvironmentActionsMenu } from "./EnvironmentActionsMenu";

// Only the descriptor and saved name are read by this control.
const config = {
  environment: { capabilities: { environmentLabel: true } },
  settings: { environmentLabel: "Build laptop" },
} as ServerConfig;

async function setup(access = "granted") {
  // The default viewport is phone-sized, where the dialog's footer falls below the fold.
  await page.viewport(1280, 900);
  vi.clearAllMocks();
  state.access = access;
}

const renderMenu = (serverConfig: ServerConfig | null) =>
  render(
    <EnvironmentActionsMenu
      environmentId={EnvironmentId.make("remote")}
      label="Build laptop"
      serverConfig={serverConfig}
    />,
    { router: false },
  );

async function openMenu() {
  await userEvent.click(page.getByRole("button", { name: "More actions for Build laptop" }));
  return page.getByRole("menuitem", { name: "Rename machine…" });
}

it("keeps editing open until the save receipt arrives and allows retry after failure", async () => {
  await setup();
  let finish!: (value: { _tag: string }) => void;
  state.persist.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await using _screen = await renderMenu(config);
  await userEvent.click(await openMenu());
  await userEvent.click(page.getByRole("button", { name: "Save" }));
  await expect.element(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect.element(page.getByRole("dialog")).toBeVisible();

  await act(() => finish({ _tag: "Failure" }));
  await expect.element(page.getByText("Could not save the machine name. Try again.")).toBeVisible();

  state.persist.mockResolvedValueOnce({ _tag: "Success" });
  await userEvent.click(page.getByRole("button", { name: "Reset name" }));
  expect(state.persist).toHaveBeenLastCalledWith({
    environmentId: "remote",
    input: { patch: { environmentLabel: null } },
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  ["disconnected", null, "granted"],
  [
    "older",
    { ...config, environment: { capabilities: { environmentLabel: false } } } as ServerConfig,
    "granted",
  ],
  ["read-only", config, "denied"],
] as const)("does not offer rename for %s machines", async (_kind, serverConfig, access) => {
  await setup(access);
  await using _screen = await renderMenu(serverConfig);
  await expect.element(await openMenu()).toHaveAttribute("aria-disabled", "true");
  expect(state.persist).not.toHaveBeenCalled();
});
