import { describe, expect, it } from "vite-plus/test";

import {
  AGENTS_PROFILES_PANE,
  AGENTS_THREADS_PANE,
  resolveAgentsPaneMaxWidths,
} from "./useAgentsPaneWidths";

describe("resolveAgentsPaneMaxWidths", () => {
  it("lets wide windows reach each pane's own cap", () => {
    expect(
      resolveAgentsPaneMaxWidths({
        workspaceWidth: 2400,
        profilesWidth: 300,
        profilesVisible: true,
      }),
    ).toEqual({ profiles: AGENTS_PROFILES_PANE.max, threads: AGENTS_THREADS_PANE.max });
  });

  it("keeps the chat readable by shrinking the thread list beside a wide profiles pane", () => {
    const max = resolveAgentsPaneMaxWidths({
      workspaceWidth: 1280,
      profilesWidth: 400,
      profilesVisible: true,
    });
    expect(max.threads).toBe(1280 - 420 - 400);
    expect(max.profiles).toBe(Math.min(AGENTS_PROFILES_PANE.max, 1280 - 420 - 280));
  });

  it("gives the folded profiles pane's room to threads on narrow windows", () => {
    expect(
      resolveAgentsPaneMaxWidths({
        workspaceWidth: 900,
        profilesWidth: 400,
        profilesVisible: false,
      }).threads,
    ).toBe(900 - 420);
  });

  it("never drops below the pane minimums when the window cannot fit everything", () => {
    expect(
      resolveAgentsPaneMaxWidths({
        workspaceWidth: 600,
        profilesWidth: 300,
        profilesVisible: true,
      }),
    ).toEqual({ profiles: AGENTS_PROFILES_PANE.min, threads: AGENTS_THREADS_PANE.min });
  });
});
