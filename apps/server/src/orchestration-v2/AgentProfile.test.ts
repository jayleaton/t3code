import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type McpGatewayProfile } from "@t3tools/contracts";
import { agentProfilePrompt, resolveThreadCreateProfile } from "./AgentProfile.ts";

const profile: McpGatewayProfile = {
  profileId: "review",
  name: "Reviewer",
  revision: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  reasoningEffort: "high",
  systemPrompt: "Review changes carefully.",
};
const command = { profileSelection: { profileId: "review", revision: 3, overrideFields: [] } };

describe("V2 profile association", () => {
  it("freezes instructions and defaults independently of subsequent library edits", () => {
    const resolved = resolveThreadCreateProfile(command, [profile]);
    expect(resolved).toMatchObject({
      runtimeMode: "approval-required",
      modelSelection: {
        model: "test-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      profileSnapshot: { profileId: "review", revision: 3 },
    });
    const edited = { ...profile, revision: 4, systemPrompt: "New instructions" };
    expect(() => resolveThreadCreateProfile(command, [edited])).toThrow(/stale/);
    expect(agentProfilePrompt("Check this patch", resolved.profileSnapshot)).toContain(
      "Review changes carefully.",
    );
    expect(agentProfilePrompt("Check this patch", resolved.profileSnapshot)).not.toContain(
      "New instructions",
    );
    expect(agentProfilePrompt("Normal chat", undefined)).toBe("Normal chat");
  });
  it("rejects missing, stale, read-only profiles and incomplete overrides", () => {
    expect(() => resolveThreadCreateProfile(command, [])).toThrow(/missing/);
    expect(() =>
      resolveThreadCreateProfile(command, [{ ...profile, runtimeMode: "read-only" }]),
    ).toThrow(/read-only/);
    expect(() =>
      resolveThreadCreateProfile(
        { profileSelection: { ...command.profileSelection, overrideFields: ["modelSelection"] } },
        [profile],
      ),
    ).toThrow(/override/);
  });
  it("records an explicit model override while retaining profile instructions", () => {
    const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "other" };
    const resolved = resolveThreadCreateProfile(
      {
        modelSelection,
        profileSelection: {
          ...command.profileSelection,
          overrideFields: ["modelSelection", "reasoningEffort"],
        },
      },
      [profile],
    );
    expect(resolved.modelSelection).toEqual(modelSelection);
    expect(resolved.profileSnapshot?.effectiveSource.modelSelection).toBe("thread-override");
    expect(resolved.profileSnapshot?.systemPrompt).toBe(profile.systemPrompt);
  });
});
