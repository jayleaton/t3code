// @vitest-environment happy-dom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
const state = vi.hoisted(() => ({ persist: vi.fn(), access: "granted" }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("./EnvironmentIconPicker", () => ({
  EnvironmentIconMenu: () => null,
  useEnvironmentOperateAccess: () => state.access,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: ReactNode }) => children,
  MenuItem: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogPopup: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => children,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogPanel: ({ children }: { children: ReactNode }) => children,
  DialogFooter: ({ children }: { children: ReactNode }) => children,
}));
import { EnvironmentActionsMenu } from "./EnvironmentActionsMenu";
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(async () => {
  await act(async () => root.render(null));
  vi.clearAllMocks();
  state.access = "granted";
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
const render = (config: ServerConfig | null) =>
  act(async () =>
    root.render(
      <EnvironmentActionsMenu
        environmentId={EnvironmentId.make("remote")}
        label="Build laptop"
        serverConfig={config}
      />,
    ),
  );
// Only the descriptor and saved name are read by this control.
const config = {
  environment: { capabilities: { environmentLabel: true } },
  settings: { environmentLabel: "Build laptop" },
} as ServerConfig;

it("keeps editing open until the save receipt arrives and allows retry after failure", async () => {
  let finish!: (value: { _tag: string }) => void;
  state.persist.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(config);
  await act(async () => button("Rename machine…").click());
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(button("Saving…").disabled).toBe(true);
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finish({ _tag: "Failure" }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  state.persist.mockResolvedValueOnce({ _tag: "Success" });
  await act(async () => button("Reset name").click());
  expect(state.persist).toHaveBeenLastCalledWith({
    environmentId: "remote",
    input: { patch: { environmentLabel: null } },
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("does not offer rename for disconnected, older, or read-only machines", async () => {
  for (const value of [
    null,
    {
      ...config,
      environment: {
        ...config.environment,
        capabilities: { ...config.environment.capabilities, environmentLabel: false },
      },
    },
  ]) {
    await render(value);
    expect(button("Rename machine…").disabled).toBe(true);
  }
  state.access = "denied";
  await render(config);
  expect(button("Rename machine…").disabled).toBe(true);
  expect(state.persist).not.toHaveBeenCalled();
});
