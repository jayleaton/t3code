// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
const openPrLink = vi.hoisted(() => vi.fn((event: MouseEvent) => event.preventDefault()));
vi.mock("../../state/entities", () => ({ useProject: () => ({ title: "Project" }) }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => openPrLink }));
vi.mock("../ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  prStatusIndicator: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../ui/preview-card", () => ({
  PreviewCard: ({ children }: { children: ReactNode }) => children,
  PreviewCardTrigger: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  PreviewCardPopup: () => null,
}));
vi.mock("./AgentChatPreview", () => ({ AgentChatPreview: () => null }));
vi.mock("./ThreadSpeedControl", () => ({ ThreadSpeedControl: () => null }));
import { ThreadCard } from "./ThreadCard";
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterEach(async () => {
  await act(async () => root.render(null));
  vi.clearAllMocks();
});
describe("agent card PR navigation", () => {
  it.each(["linkedPullRequest", "branchPullRequest"] as const)(
    "opens %s even while PR details are unavailable",
    async (field) => {
      const reference = {
        projectId: ProjectId.make("project"),
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      };
      const thread = {
        id: ThreadId.make("chat"),
        environmentId: EnvironmentId.make("remote"),
        projectId: reference.projectId,
        title: "Agent chat",
        updatedAt: "2026-09-10T00:00:00Z",
        settledAt: null,
        [field]: reference,
      } as EnvironmentThreadShell;
      await act(async () => root.render(<ThreadCard thread={thread} onContextMenu={vi.fn()} />));
      const link = container.querySelector<HTMLAnchorElement>(`a[href="${reference.url}"]`)!;
      expect(link).not.toBeNull();
      await act(async () => link.click());
      expect(openPrLink).toHaveBeenCalledWith(
        expect.anything(),
        reference.url,
        undefined,
        thread.environmentId,
      );
    },
  );
});
