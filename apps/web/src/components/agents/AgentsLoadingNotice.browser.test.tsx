import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { AgentsLoadingNotice } from "./AgentsLoadingNotice";

it("shows initial loading without reinserting a banner during environment retries", async () => {
  await using screen = await render(<AgentsLoadingNotice ready={false} />, { router: false });
  const status = () => screen.container.querySelector('[role="status"]');
  expect(status()?.textContent).toContain("Loading connected environments");
  await screen.rerender(<AgentsLoadingNotice ready />);
  expect(status()).toBeNull();
  for (const ready of [false, true, false]) {
    await screen.rerender(<AgentsLoadingNotice ready={ready} />);
    expect(status()).toBeNull();
  }
});

it("does not show loading when the board opens with cached snapshots", async () => {
  await using screen = await render(<AgentsLoadingNotice ready />, { router: false });
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
  await screen.rerender(<AgentsLoadingNotice ready={false} />);
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
});
