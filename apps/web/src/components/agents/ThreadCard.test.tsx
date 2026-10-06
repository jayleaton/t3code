import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { v2ThreadShell } from "./agents.testFixtures";
// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, RunId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
const openPrLink = vi.hoisted(() => vi.fn((event: MouseEvent) => event.preventDefault()));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("../../state/entities", () => ({ useProject: () => ({ title: "Project" }) }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => openPrLink }));
vi.mock("../ThreadStatusIndicators", () => ({
  useLinkedThreadPullRequest: () => null,
  prStatusIndicator: () => null,
  linkedPullRequestSnapshotStatus: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => "/agents",
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("../ui/preview-card", () => ({
  PreviewCard: ({ children }: { children: ReactNode }) => children,
  PreviewCardTrigger: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  PreviewCardPopup: () => null,
}));
vi.mock("./AgentChatPreview", () => ({ AgentChatPreview: () => null }));
import { ThreadCard } from "./ThreadCard";
import type { AgentCardChildren } from "./agents.logic";
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
  it.each(["linkedPullRequest", "branchPullRequest", "pullRequests"] as const)(
    "opens %s even while PR details are unavailable",
    async (field) => {
      const reference = {
        projectId: ProjectId.make("project"),
        repository: "owner/repo",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
      };
      const thread = {
        ...presentThreadShell(EnvironmentId.make("remote"), v2ThreadShell),
        id: ThreadId.make("chat"),
        environmentId: EnvironmentId.make("remote"),
        projectId: reference.projectId,
        title: "Agent chat",
        updatedAt: "2026-09-10T00:00:00Z",
        settledAt: null,
        ...(field === "pullRequests"
          ? {
              pullRequests: [42, 43].map((number) => ({
                host: "github.com",
                repository: "owner/repo",
                number,
                url: `https://github.com/owner/repo/pull/${number}`,
                source: "agent" as const,
                linkedAt: "2026-09-10T00:00:00Z",
                snapshot: null,
                stack: null,
              })),
            }
          : { [field]: reference }),
      } satisfies EnvironmentThreadShell;
      await act(async () => root.render(<ThreadCard thread={thread} onContextMenu={vi.fn()} />));
      const link = container.querySelector<HTMLAnchorElement>(`a[href="${reference.url}"]`)!;
      expect(link).not.toBeNull();
      if (field === "pullRequests")
        expect(
          container.querySelector('a[href="https://github.com/owner/repo/pull/43"]'),
        ).not.toBeNull();
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

describe("agent card linked chats", () => {
  const parent = presentThreadShell(EnvironmentId.make("remote"), v2ThreadShell);
  const child = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) => ({
    thread: {
      ...parent,
      id: ThreadId.make(id),
      title: id,
      profileSnapshot: {
        profileId: "cody",
        profileName: "Cody",
        revision: 1,
        effectiveSource: {
          modelSelection: "profile",
          runtimeMode: "profile",
          interactionMode: "profile",
          reasoningEffort: "profile",
        },
      } satisfies EnvironmentThreadShell["profileSnapshot"],
      parentThreadId: parent.id,
      lineage: {
        rootThreadId: parent.id,
        parentThreadId: parent.id,
        relationshipToParent: null,
      },
      ...overrides,
    },
    depth: 0,
    siblings: [],
  });
  const done = {
    latestRun: {
      runId: RunId.make("run"),
      status: "completed",
      requestedAt: "2026-09-10T00:00:00Z",
      startedAt: "2026-09-10T00:00:00Z",
      completedAt: "2026-09-10T00:01:00Z",
      assistantMessageId: null,
    },
  } satisfies Partial<EnvironmentThreadShell>;
  const runs: AgentCardChildren<EnvironmentThreadShell> = {
    live: [
      ...Array.from({ length: 20 }, (_, index) => child(`Finished worker ${index}`, done)),
      child("Running worker", {
        latestRun: { ...done.latestRun, status: "running", completedAt: null },
      }),
      child("Waiting worker", { hasPendingUserInput: true }),
    ],
    settled: [child("Settled worker", { settledAt: "2026-09-10T00:00:00Z" })],
  };

  it("keeps linked Agent chats and supports expanding and collapsing settled chats", async () => {
    await act(async () =>
      root.render(<ThreadCard thread={parent} childRuns={runs} onContextMenu={vi.fn()} />),
    );
    expect(container.textContent).toContain("Finished worker 19");
    expect(container.textContent).toContain("Cody");
    expect(container.textContent).not.toContain("Settled worker");
    const toggle = container.querySelector<HTMLButtonElement>(".agent-thread-children-settled")!;
    await act(async () => toggle.click());
    expect(container.textContent).toContain("Settled worker");
    await act(async () => toggle.click());
    expect(container.textContent).not.toContain("Settled worker");
  });
});

describe("agent card settle action", () => {
  const topLevel = {
    ...presentThreadShell(EnvironmentId.make("remote"), v2ThreadShell),
    id: ThreadId.make("chat"),
    environmentId: EnvironmentId.make("remote"),
    title: "Agent chat",
    updatedAt: "2026-09-10T00:00:00Z",
    settledAt: null,
  } satisfies EnvironmentThreadShell;

  it("renders the settle control on the card, not inside its link", async () => {
    await act(async () =>
      root.render(
        <ThreadCard
          thread={topLevel}
          settleSupported
          onSettleAction={vi.fn()}
          onContextMenu={vi.fn()}
        />,
      ),
    );
    const actions = container.querySelector(".agent-thread-container > .agent-thread-actions");
    expect(actions?.querySelector('button[aria-label="Settle chat"]')).not.toBeNull();
    // A button nested in the card's link would be invalid and steal its click.
    expect(container.querySelector("a button")).toBeNull();
  });

  it("settles through the shared action when the control is clicked", async () => {
    const onSettleAction = vi.fn();
    await act(async () =>
      root.render(
        <ThreadCard
          thread={topLevel}
          settleSupported
          onSettleAction={onSettleAction}
          onContextMenu={vi.fn()}
        />,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Settle chat"]')!;
    await act(async () => button.click());
    expect(onSettleAction).toHaveBeenCalledWith(topLevel);
  });

  it("offers un-settle for a settled card", async () => {
    await act(async () =>
      root.render(
        <ThreadCard
          thread={{ ...topLevel, settledAt: "2026-09-10T00:05:00Z" }}
          settleSupported
          onSettleAction={vi.fn()}
          onContextMenu={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector('button[aria-label="Un-settle chat"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Settle chat"]')).toBeNull();
  });

  it("never renders the action for a child card or an unsupported server", async () => {
    await act(async () =>
      root.render(
        <ThreadCard
          thread={{ ...topLevel, parentThreadId: ThreadId.make("parent") }}
          settleSupported
          onSettleAction={vi.fn()}
          onContextMenu={vi.fn()}
        />,
      ),
    );
    expect(container.querySelector(".agent-thread-settle")).toBeNull();

    await act(async () =>
      root.render(
        <ThreadCard thread={topLevel} onSettleAction={vi.fn()} onContextMenu={vi.fn()} />,
      ),
    );
    expect(container.querySelector(".agent-thread-settle")).toBeNull();
  });
});
