import { describe, expect, it, vi } from "vite-plus/test";

import { resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("ignores inherited Clerk and relay values in a personal client", () => {
    expect(
      resolveCloudPublicConfig({
        personalClient: true,
        clerk: { publishableKey: "pk_test_inherited", jwtTemplate: "t3-relay" },
        relay: { url: "https://relay.example.test" },
      }),
    ).toEqual({
      clerk: { publishableKey: null, jwtTemplate: null },
      relay: { url: null },
      observability: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });
});
