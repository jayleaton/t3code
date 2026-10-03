import { describe, expect, it } from "vite-plus/test";
import { agentLibraryForSync, mergeAgentLibraries, type McpGatewayProfile } from "./settings.ts";
const profile = (id: string, updatedAt: string, name = id): McpGatewayProfile => ({
  profileId: id,
  name,
  updatedAt,
  createdAt: "2026-01-01",
  revision: 1,
  runtimeMode: "auto",
  interactionMode: "default",
});
describe("agent library convergence", () => {
  it("merges independent edits and converges regardless of environment order", () => {
    const a = {
      mcpGatewayProfiles: [profile("one", "2026-01-03", "New name"), profile("two", "2026-01-01")],
    };
    const b = {
      mcpGatewayProfiles: [
        profile("one", "2026-01-01"),
        { ...profile("two", "2026-01-04"), color: "#123456", icon: "code" as const },
      ],
    };
    const merged = mergeAgentLibraries([a, b]);
    expect(mergeAgentLibraries([b, a])).toEqual(merged);
    expect(merged.mcpGatewayProfiles).toMatchObject([
      { name: "New name" },
      { color: "#123456", icon: "code" },
    ]);
    expect(mergeAgentLibraries([merged, a, b])).toEqual(merged);
  });
  it("does not resurrect a deleted agent when an old device reconnects", () => {
    const stale = { mcpGatewayProfiles: [profile("one", "2026-01-01")] };
    const deleted = { mcpGatewayProfiles: [], mcpGatewayProfileDeletedAt: { one: "2026-01-02" } };
    expect(mergeAgentLibraries([stale, deleted]).mcpGatewayProfiles).toEqual([]);
    expect(mergeAgentLibraries([deleted, stale])).toEqual(mergeAgentLibraries([stale, deleted]));
  });
  it("allows a newer explicit edit while retaining independent agents", () => {
    const merged = mergeAgentLibraries([
      {
        mcpGatewayProfiles: [profile("one", "2026-01-03"), profile("two", "2026-01-01")],
        mcpGatewayProfileDeletedAt: { one: "2026-01-02" },
      },
    ]);
    expect(merged.mcpGatewayProfiles).toHaveLength(2);
  });
});

it("propagates reusable skill edits and deletions without changing agent assignments", () => {
  const skill = {
    skillId: "review",
    name: "Review",
    description: "Review code",
    content: "Old rules",
    revision: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const original = {
    mcpGatewayProfiles: [{ ...profile("randy", "2026-01-01"), skillIds: ["review"] }],
    agentSkills: [skill],
  };
  const edited = {
    mcpGatewayProfiles: [],
    agentSkills: [{ ...skill, revision: 2, content: "New rules", updatedAt: "2026-01-02" }],
  };
  const merged = mergeAgentLibraries([original, edited]);
  expect(merged.agentSkills[0]?.content).toBe("New rules");
  expect(merged.mcpGatewayProfiles[0]?.skillIds).toEqual(["review"]);
  expect(mergeAgentLibraries([edited, original])).toEqual(merged);
  const deleted = { mcpGatewayProfiles: [], agentSkillDeletedAt: { review: "2026-01-03" } };
  expect(mergeAgentLibraries([merged, deleted, original]).agentSkills).toEqual([]);
  expect(mergeAgentLibraries([deleted, merged, original]).agentSkills).toEqual([]);
});

it("keeps assignments when an older server echoes the same revision without skill support", () => {
  const assigned = { ...profile("randy", "2026-01-01"), skillIds: ["review"] };
  const library = mergeAgentLibraries([{ mcpGatewayProfiles: [assigned] }]);
  const legacy = agentLibraryForSync(library, false);
  expect(legacy.mcpGatewayProfiles[0]).not.toHaveProperty("skillIds");
  expect(mergeAgentLibraries([legacy, library]).mcpGatewayProfiles[0]?.skillIds).toEqual([
    "review",
  ]);
  expect(mergeAgentLibraries([library, legacy]).mcpGatewayProfiles[0]?.skillIds).toEqual([
    "review",
  ]);
});
