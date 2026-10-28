import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { filterSharedServerPatch, splitSharedServerPatch } from "./sharedSettings.ts";

const restartCapabilities = { threadRestartContinuation: true, agentSkillsSync: true };

describe("filterSharedServerPatch", () => {
  it("holds the restart preference until the target's config loads", () => {
    const patch = { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    expect(filterSharedServerPatch(patch, restartCapabilities, DEFAULT_SERVER_SETTINGS)).toEqual(
      patch,
    );
  });

  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(
        filterSharedServerPatch(patch, restartCapabilities, settings, settings, targetIsSource),
      ).toEqual({
        ...(targetIsSource
          ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
          : {}),
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      });
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, restartCapabilities, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );
});

it("shares the complete profile list and propagates deletions", () => {
  const profiles = [
    {
      profileId: "write",
      name: "Write",
      revision: 2,
      providerLabel: "Codex",
      modelLabel: "GPT",
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T01:00:00.000Z",
    },
  ];
  expect(splitSharedServerPatch({ mcpGatewayProfiles: profiles })).toEqual({
    sharedPatch: { mcpGatewayProfiles: profiles },
    localPatch: {},
  });
  expect(splitSharedServerPatch({ mcpGatewayProfiles: [] }).sharedPatch).toEqual({
    mcpGatewayProfiles: [],
  });
});
