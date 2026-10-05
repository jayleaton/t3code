import { describe, expect, it } from "vite-plus/test";
import type { McpGatewayProfile } from "@t3tools/contracts";
import {
  collapsedNewChatChoices,
  defaultNewChatMachine,
  defaultNewChatProfile,
  emptyNewChatHistory,
  recordNewChat,
  sortProfilesByNewChatPick,
  sortProjectsByNewChatPick,
} from "./agentNewChat.logic";

const agent = (name: string, runtimeMode: McpGatewayProfile["runtimeMode"] = "full-access") =>
  ({ profileId: name.toLowerCase(), name, runtimeMode }) as McpGatewayProfile;

describe("defaultNewChatProfile", () => {
  it("prefers Captain wherever it sits in the board order", () => {
    expect(defaultNewChatProfile([agent("Cody"), agent(" captain ")])?.profileId).toBe(" captain ");
  });
  it("falls back to the first agent that can start chats", () => {
    expect(
      defaultNewChatProfile([
        agent("Captain", "read-only"),
        agent("Reader", "read-only"),
        agent("Cody"),
      ])?.profileId,
    ).toBe("cody");
    expect(defaultNewChatProfile([agent("Reader", "read-only")])).toBeUndefined();
  });
});

describe("defaultNewChatMachine", () => {
  it("keeps the last machine while it can run the agent", () => {
    expect(defaultNewChatMachine(["mac", "windows"], "windows")).toBe("windows");
  });
  it("falls back to the first eligible machine, or none", () => {
    expect(defaultNewChatMachine(["mac", "windows"], "linux")).toBe("mac");
    expect(defaultNewChatMachine(["mac"], null)).toBe("mac");
    expect(defaultNewChatMachine([], "mac")).toBe("");
  });
});

describe("new chat pick order", () => {
  const project = (id: string, environmentId = "mac") => ({ environmentId, id, title: id });
  const picks = [
    { profileId: "cody", projectId: "lockpick", at: "2026-10-01T00:00:00.000Z" },
    { profileId: "captain", projectId: "t3", at: "2026-09-01T00:00:00.000Z" },
    { profileId: "doug", projectId: "sidebud", at: "2026-10-03T00:00:00.000Z" },
    { profileId: "captain", projectId: "t3", at: "2026-10-05T00:00:00.000Z" },
  ].reduce(
    (history, pick) => recordNewChat(history, { ...pick, environmentId: "mac" }),
    emptyNewChatHistory,
  );

  it("puts the most recently created project first, then the rest alphabetically", () => {
    const sorted = sortProjectsByNewChatPick(
      [project("zeta"), project("lockpick"), project("sidebud"), project("t3"), project("alpha")],
      picks,
    );
    expect(sorted.map(({ id }) => id)).toEqual(["t3", "sidebud", "lockpick", "alpha", "zeta"]);
  });
  it("keeps the same project id on another machine separate", () => {
    const sorted = sortProjectsByNewChatPick(
      [project("alpha", "windows"), project("t3", "windows")],
      picks,
    );
    expect(sorted.map(({ id }) => id)).toEqual(["alpha", "t3"]);
  });
  it("puts the most recently chosen agent first and keeps board order for the rest", () => {
    const sorted = sortProfilesByNewChatPick(
      ["reel", "doug", "alex", "captain", "cody"].map((profileId) => ({ profileId })),
      picks,
    );
    expect(sorted.map(({ profileId }) => profileId)).toEqual([
      "captain",
      "doug",
      "cody",
      "reel",
      "alex",
    ]);
    expect(picks.machine).toBe("mac");
  });
});

describe("collapsedNewChatChoices", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  it("shows the first four", () => {
    expect(collapsedNewChatChoices(items, () => false, 4)).toEqual(["a", "b", "c", "d"]);
  });
  it("keeps a selection beyond them visible in the last slot", () => {
    expect(collapsedNewChatChoices(items, (item) => item === "f", 4)).toEqual(["a", "b", "c", "f"]);
    expect(collapsedNewChatChoices(items, (item) => item === "b", 4)).toEqual(["a", "b", "c", "d"]);
  });
});
