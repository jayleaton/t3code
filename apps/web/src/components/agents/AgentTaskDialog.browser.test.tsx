import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import { act, fakeTimers, render, type Screen } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";

const state = vi.hoisted(() => ({
  environments: [] as unknown[],
  projects: [] as unknown[],
  createThread: vi.fn(async () => ({})),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => navigate,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({ _tag: "Success", value: {} })) as never,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  useEnvironmentProviders: () =>
    new Map(
      (
        state.environments as Array<{
          environmentId: string;
          serverConfig?: { providers?: unknown[] } | null;
        }>
      ).map((env) => [env.environmentId, env.serverConfig?.providers ?? []]),
    ),
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
const onClose = vi.fn();
const cody: McpGatewayProfile = { ...profile, profileId: "cody", name: "Cody" };
const profiles = [cody, profile];
// The hook mocks are not subscriptions, so each render passes a fresh onClose
// to get past the compiler's memoized form, as a store update would.
const dialog = () => (
  <AgentTaskDialog profiles={profiles} orderedProfiles={profiles} onClose={() => onClose()} />
);
const open = () => render(dialog(), { router: false });
const refresh = (screen: Screen) => screen.rerender(dialog());
const machineSelect = (screen: Screen) => screen.container.querySelector("select")!;
const selectMachine = (screen: Screen, value: string) =>
  userEvent.selectOptions(machineSelect(screen), value);
const choose = (screen: Screen, group: "agent" | "project", value: string) =>
  act(() =>
    screen.container
      .querySelector<HTMLInputElement>(`input[name="agent-task-${group}"][value="${value}"]`)!
      .click(),
  );
const cardNames = (screen: Screen, group: "agent" | "project") =>
  Array.from(screen.container.querySelectorAll(`input[name="agent-task-${group}"]`)).map(
    (input) => input.closest("label")!.querySelector(".agent-choice-name")!.textContent,
  );
const checkedProject = (screen: Screen) =>
  screen.container.querySelector<HTMLInputElement>('input[name="agent-task-project"]:checked')
    ?.value;
const clickButton = (screen: Screen, text: string) =>
  act(() =>
    Array.from(screen.container.querySelectorAll("button"))
      .find((button) => button.textContent === text)!
      .click(),
  );
const submit = (screen: Screen) => clickButton(screen, "Create empty chat");

function setup(): Disposable {
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
  return { [Symbol.dispose]: () => localStorage.clear() };
}

describe("Agents new chat workspace", () => {
  it("keeps the agent permission mode explicit instead of inheriting the project default", async () => {
    using _setup = setup();
    await using screen = await open();
    await selectMachine(screen, mac);
    await choose(screen, "project", t3code);
    const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadKey);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });
  it("keeps disconnected machines visible and prevents submission if the selected machine disconnects", async () => {
    using _setup = setup();
    await using screen = await open();
    await selectMachine(screen, mac);
    await choose(screen, "project", t3code);
    state.environments = [
      { environmentId: mac, label: "MacBook", connection: { phase: "offline" } },
    ];
    await refresh(screen);
    const option = machineSelect(screen).options[1]!;
    expect(option.text).toContain("MacBook: Not connected");
    expect(option.disabled).toBe(true);
    expect(screen.container.textContent).toContain("Settings → Connections");
    await submit(screen);
    expect(state.createThread).not.toHaveBeenCalled();
  });
  it("only lists the chosen machine's projects and sends the explicit project despite updates", async () => {
    using _setup = setup();
    await using screen = await open();
    await selectMachine(screen, mac);
    expect(cardNames(screen, "project")).toEqual(["buildthings", "t3code"]);
    await choose(screen, "project", t3code);
    state.projects = state.projects.toReversed();
    await refresh(screen);
    expect(screen.container.textContent).toContain("/projects/mac/t3code");
    await submit(screen);
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: mac, projectId: t3code }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires a fresh project choice after switching machines", async () => {
    using _setup = setup();
    await using screen = await open();
    await selectMachine(screen, mac);
    await choose(screen, "project", t3code);
    await selectMachine(screen, windows);
    await submit(screen);
    expect(state.createThread).not.toHaveBeenCalled();
    expect(checkedProject(screen)).toBeUndefined();
    await choose(screen, "project", t3code);
    await submit(screen);
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: windows, projectId: t3code }),
    );
  });
  it("does not send an agent draft through an older server that would discard its profile", async () => {
    using _setup = setup();
    state.environments = [
      {
        environmentId: mac,
        label: "mac",
        connection: { phase: "connected" },
        serverConfig: { providers: [], environment: { capabilities: {} } },
      },
    ];
    await using screen = await open();
    await selectMachine(screen, mac);
    await choose(screen, "project", t3code);
    expect(screen.container.textContent).not.toContain("Standard composer");
    expect(screen.container.textContent).toContain("Update this machine");
    await submit(screen);
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: mac, projectId: t3code }),
    );
  });
  it("does not fall back when the selected project disappears", async () => {
    using _setup = setup();
    await using screen = await open();
    await selectMachine(screen, mac);
    await choose(screen, "project", t3code);
    state.projects = [makeProject(mac, buildthings, "buildthings")];
    await refresh(screen);
    await submit(screen);
    expect(state.createThread).not.toHaveBeenCalled();
    expect(checkedProject(screen)).toBeUndefined();
  });
  it("opens on Captain and the machine the last new chat was created on", async () => {
    using _setup = setup();
    localStorage.setItem(
      "t3code:agents:new-chat-history",
      JSON.stringify({ machine: windows, agents: {}, projects: {} }),
    );
    await using screen = await open();
    expect(screen.container.querySelector("h2")!.textContent).toBe("New chat · Captain");
    expect(machineSelect(screen).value).toBe(windows);
    await choose(screen, "project", t3code);
    await submit(screen);
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: windows,
        projectId: t3code,
        profileSelection: expect.objectContaining({ profileId: "captain" }),
      }),
    );
  });
  it("remembers the machine a chat was created on and falls back when it is unavailable", async () => {
    using _setup = setup();
    {
      await using screen = await open();
      expect(machineSelect(screen).value).toBe(mac);
      await selectMachine(screen, windows);
      await choose(screen, "project", t3code);
      await submit(screen);
    }
    expect(JSON.parse(localStorage.getItem("t3code:agents:new-chat-history")!).machine).toBe(
      windows,
    );
    state.environments = state.environments.slice(0, 1);
    await using screen = await open();
    expect(machineSelect(screen).value).toBe(mac);
  });
  it("keeps a defaulted machine once a project is chosen, even if it disconnects", async () => {
    using _setup = setup();
    await using screen = await open();
    await choose(screen, "project", t3code);
    state.environments = [
      { environmentId: mac, label: "mac", connection: { phase: "offline" } },
      ...state.environments.slice(1),
    ];
    await refresh(screen);
    await submit(screen);
    expect(state.createThread).not.toHaveBeenCalled();
    expect(machineSelect(screen).value).toBe(mac);
  });
  it("orders cards by the user's last picks and records each created chat", async () => {
    using _setup = setup();
    {
      using _timers = fakeTimers();
      vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
      await using screen = await open();
      await choose(screen, "agent", "cody");
      await choose(screen, "project", buildthings);
      await submit(screen);
      vi.setSystemTime(new Date("2026-10-05T11:00:00.000Z"));
      await choose(screen, "agent", "captain");
      await choose(screen, "project", t3code);
      await submit(screen);
    }
    await using screen = await open();
    // Board order is Cody, Captain and titles sort buildthings first; the last pick wins both.
    expect(cardNames(screen, "agent")).toEqual(["Captain", "Cody"]);
    expect(cardNames(screen, "project")).toEqual(["t3code", "buildthings"]);
  });
  it("collapses long lists to four cards behind Show more", async () => {
    using _setup = setup();
    state.projects = ["a", "b", "c", "d", "e", "f"].map((title) =>
      makeProject(mac, ProjectId.make(title), title),
    );
    await using screen = await open();
    expect(cardNames(screen, "project")).toEqual(["a", "b", "c", "d"]);
    await clickButton(screen, "Show 2 more");
    expect(cardNames(screen, "project")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
  it("searches every project by name or path, keeping the selection", async () => {
    using _setup = setup();
    state.projects = ["alpha", "bravo", "charlie", "delta", "echo", "Foxtrot"].map((title) =>
      makeProject(mac, ProjectId.make(title.toLowerCase()), title),
    );
    await using screen = await open();
    const search = (value: string) =>
      userEvent.fill(
        screen.container.querySelector<HTMLInputElement>('input[aria-label="Search projects"]')!,
        value,
      );
    const showMore = () =>
      Array.from(screen.container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Show "),
      );
    await choose(screen, "project", "bravo");
    expect(cardNames(screen, "project")).toEqual(["alpha", "bravo", "charlie", "delta"]);

    // A project collapsed behind Show more is reachable, ignoring case.
    await search("FOX");
    expect(cardNames(screen, "project")).toEqual(["Foxtrot"]);
    expect(showMore()).toBeUndefined();
    // The selection is kept while it is filtered out of view.
    expect(checkedProject(screen)).toBeUndefined();
    await search(`/projects/${mac}/e`);
    expect(cardNames(screen, "project")).toEqual(["echo"]);

    await search("zulu");
    expect(cardNames(screen, "project")).toEqual([]);
    expect(screen.container.querySelector('[role="status"]')!.textContent).toContain(
      "match “zulu”",
    );

    await search("");
    expect(cardNames(screen, "project")).toEqual(["alpha", "bravo", "charlie", "delta"]);
    expect(checkedProject(screen)).toBe("bravo");
    expect(showMore()!.textContent).toBe("Show 2 more");
  });
  it("starts the chat with whichever agent card is chosen", async () => {
    using _setup = setup();
    await using screen = await open();
    await choose(screen, "agent", "cody");
    expect(screen.container.querySelector("h2")!.textContent).toBe("New chat · Cody");
    await choose(screen, "project", buildthings);
    await submit(screen);
    expect(state.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ profileSelection: expect.objectContaining({ profileId: "cody" }) }),
    );
  });
});
