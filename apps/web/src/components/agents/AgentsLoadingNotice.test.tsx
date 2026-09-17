// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vite-plus/test";
import { AgentsLoadingNotice } from "./AgentsLoadingNotice";

const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(async () => {
  await act(async () => root.render(null));
});

it("shows initial loading without reinserting a banner during environment retries", async () => {
  const render = async (ready: boolean) => {
    await act(async () => root.render(<AgentsLoadingNotice ready={ready} />));
  };
  await render(false);
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Loading connected environments",
  );
  await render(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
  for (const ready of [false, true, false]) {
    await render(ready);
    expect(container.querySelector('[role="status"]')).toBeNull();
  }
});

it("does not show loading when the board opens with cached snapshots", async () => {
  await act(async () => root.render(<AgentsLoadingNotice ready />));
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => root.render(<AgentsLoadingNotice ready={false} />));
  expect(container.querySelector('[role="status"]')).toBeNull();
});
