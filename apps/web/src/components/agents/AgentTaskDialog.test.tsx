// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import { useComposerDraftStore } from "../../composerDraftStore";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  projects: [] as unknown[],
  createThread: vi.fn(async () => ({})),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Success", value: {} }) }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
}));
vi.mock("@t3tools/client-runtime/gateway", () => ({
  createGatewayRuntimePortFromContext: () => ({ createThread: state.createThread }),
  resolveGatewayProfileModelSelection: () => ({ instanceId: "codex", model: "gpt-5" }),
}));
vi.mock("../../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../ChatView", () => ({ default: () => <div>Standard composer</div> }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
import { AgentTaskDialog } from "./AgentTaskDialog";
const profile: McpGatewayProfile = {
  profileId: "captain",
  name: "Captain",
  revision: 1,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};
const mac = EnvironmentId.make("mac");
const windows = EnvironmentId.make("windows");
const t3code = ProjectId.make("t3code");
const buildthings = ProjectId.make("buildthings");
const makeProject = (environmentId: EnvironmentId, id: ProjectId, title: string) => ({
  environmentId,
  id,
  title,
  workspaceRoot: `/projects/${environmentId}/${title}`,
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const onClose = vi.fn();
const cody: McpGatewayProfile = { ...profile, profileId: "cody", name: "Cody" };
const profiles = [cody, profile];
// The hook mocks are not subscriptions, so each render passes a fresh onClose
// to get past the compiler's memoized form, as a store update would.
const render = () =>
  act(async () => {
    root.render(
      <AgentTaskDialog profiles={profiles} orderedProfiles={profiles} onClose={() => onClose()} />,
    );
  });
const machineSelect = () => container.querySelector("select")!;
const selectMachine = async (value: string) =>
  act(async () => {
    const element = machineSelect();
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
const choose = async (group: "agent" | "project", value: string) =>
  act(async () => {
    container
      .querySelector<HTMLInputElement>(`input[name="agent-task-${group}"][value="${value}"]`)!
      .click();
  });
const projectCards = () =>
  Array.from(container.querySelectorAll('input[name="agent-task-project"]')).map(
    (input) => input.closest("label")!.querySelector(".agent-choice-name")!.textContent,
  );
const agentCards = () =>
  Array.from(container.querySelectorAll('input[name="agent-task-agent"]')).map(
    (input) => input.closest("label")!.querySelector(".agent-choice-name")!.textContent,
  );
const checkedProject = () =>
  container.querySelector<HTMLInputElement>('input[name="agent-task-project"]:checked')?.value;
const submit = () =>
  act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Create empty chat")!
      .click();
  });
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  state.environments = [mac, windows].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: { providers: [], environment: { capabilities: { agentThreadBootstrap: true } } },
  }));
  state.projects = [
    makeProject(mac, buildthings, "buildthings"),
    makeProject(windows, t3code, "windows-only"),
    makeProject(mac, t3code, "t3code"),
  ];
});
afterEach(async () => {
  await act(async () => root.render(null));
});
describe("Agents new chat workspace", () => {
  it("keeps the agent permission mode explicit instead of inheriting the project default", async () => {
    await render();
    await selectMachine(mac);
    await choose("project", t3code);
    const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadKey);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });
  it("keeps disconnected machines visible and prevents submission if the selected machine disconnects", async () => {
    await render();
    await selectMachine(mac);
    await choose("project", t3code);
    state.environments = [
      { environmentId: mac, label: "MacBook", connection: { phase: "offline" } },
    ];
    await render();
    const option = machineSelect().options[1]!;
    expect(option.text).toContain("MacBook — Not connected");
    expect(option.disabled).toBe(true);
    expect(container.textContent).toContain("Settings → Connections");
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
  });
  it("only lists the chosen machine's projects and sends the explicit project despite updates", async () => {
    await render();
    await selectMachine(mac);
    expect(projectCards()).toEqual(["buildthings", "t3code"]);
    await choose("project", t3code);
    state.projects = state.projects.toReversed();
    await render();
    expect(container.textContent).toContain("/projects/mac/t3code");
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: mac, projectId: t3code }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires a fresh project choice after switching machines", async () => {
    await render();
    await selectMachine(mac);
    await choose("project", t3code);
    await selectMachine(windows);
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
    expect(checkedProject()).toBeUndefined();
    await choose("project", t3code);
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: windows, projectId: t3code }),
    );
  });
  it("does not send an agent draft through an older server that would discard its profile", async () => {
    state.environments = [
      {
        environmentId: mac,
        label: "mac",
        connection: { phase: "connected" },
        serverConfig: { providers: [], environment: { capabilities: {} } },
      },
    ];
    await render();
    await selectMachine(mac);
    await choose("project", t3code);
    expect(container.textContent).not.toContain("Standard composer");
    expect(container.textContent).toContain("Update this machine");
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: mac, projectId: t3code }),
    );
  });
  it("does not fall back when the selected project disappears", async () => {
    await render();
    await selectMachine(mac);
    await choose("project", t3code);
    state.projects = [makeProject(mac, buildthings, "buildthings")];
    await render();
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
    expect(checkedProject()).toBeUndefined();
  });
  it("opens on Captain and the machine the last new chat was created on", async () => {
    localStorage.setItem(
      "t3code:agents:new-chat-history",
      JSON.stringify({ machine: windows, agents: {}, projects: {} }),
    );
    await render();
    expect(container.querySelector("h2")!.textContent).toBe("New chat · Captain");
    expect(machineSelect().value).toBe(windows);
    await choose("project", t3code);
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: windows,
        projectId: t3code,
        profileSelection: expect.objectContaining({ profileId: "captain" }),
      }),
    );
  });
  it("remembers the machine a chat was created on and falls back when it is unavailable", async () => {
    await render();
    expect(machineSelect().value).toBe(mac);
    await selectMachine(windows);
    await choose("project", t3code);
    await submit();
    expect(JSON.parse(localStorage.getItem("t3code:agents:new-chat-history")!).machine).toBe(
      windows,
    );
    state.environments = state.environments.slice(0, 1);
    await act(async () => root.render(null));
    await render();
    expect(machineSelect().value).toBe(mac);
  });
  it("keeps a defaulted machine once a project is chosen, even if it disconnects", async () => {
    await render();
    await choose("project", t3code);
    state.environments = [
      { environmentId: mac, label: "mac", connection: { phase: "offline" } },
      ...state.environments.slice(1),
    ];
    await render();
    await submit();
    expect(state.createThread).not.toHaveBeenCalled();
    expect(machineSelect().value).toBe(mac);
  });
  it("orders cards by the user's last picks and records each created chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
      await render();
      await choose("agent", "cody");
      await choose("project", buildthings);
      await submit();
      vi.setSystemTime(new Date("2026-10-05T11:00:00.000Z"));
      await choose("agent", "captain");
      await choose("project", t3code);
      await submit();
    } finally {
      vi.useRealTimers();
    }
    await act(async () => root.render(null));
    await render();
    // Board order is Cody, Captain and titles sort buildthings first; the last pick wins both.
    expect(agentCards()).toEqual(["Captain", "Cody"]);
    expect(projectCards()).toEqual(["t3code", "buildthings"]);
  });
  it("collapses long lists to four cards behind Show more", async () => {
    state.projects = ["a", "b", "c", "d", "e", "f"].map((title) =>
      makeProject(mac, ProjectId.make(title), title),
    );
    await render();
    expect(projectCards()).toEqual(["a", "b", "c", "d"]);
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Show 2 more")!
        .click();
    });
    expect(projectCards()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  it("searches every project by name or path, keeping the selection", async () => {
    state.projects = ["alpha", "bravo", "charlie", "delta", "echo", "Foxtrot"].map((title) =>
      makeProject(mac, ProjectId.make(title.toLowerCase()), title),
    );
    const search = (value: string) =>
      act(async () => {
        const input = container.querySelector<HTMLInputElement>(
          'input[aria-label="Search projects"]',
        )!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const showMore = () =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Show "),
      );
    await render();
    await choose("project", "bravo");
    expect(projectCards()).toEqual(["alpha", "bravo", "charlie", "delta"]);

    // A project collapsed behind Show more is reachable, ignoring case.
    await search("FOX");
    expect(projectCards()).toEqual(["Foxtrot"]);
    expect(showMore()).toBeUndefined();
    // The selection is kept while it is filtered out of view.
    expect(checkedProject()).toBeUndefined();
    await search(`/projects/${mac}/e`);
    expect(projectCards()).toEqual(["echo"]);

    await search("zulu");
    expect(projectCards()).toEqual([]);
    expect(container.querySelector('[role="status"]')!.textContent).toContain("match “zulu”");

    await search("");
    expect(projectCards()).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(checkedProject()).toBe("bravo");
    expect(showMore()!.textContent).toBe("Show 2 more");
  });
  it("starts the chat with whichever agent card is chosen", async () => {
    await render();
    await choose("agent", "cody");
    expect(container.querySelector("h2")!.textContent).toBe("New chat · Cody");
    await choose("project", buildthings);
    await submit();
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ profileSelection: expect.objectContaining({ profileId: "cody" }) }),
    );
  });
});
