import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { McpEnvironmentGrantMatrix, updateMcpGatewayGrant } from "./McpGatewaySettings";

const grants = {
  "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"] as const,
  "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] as const,
};

describe("MCP environment grant matrix", () => {
  it("updates scopes by exact registry id without changing other environment grants", () => {
    expect(
      updateMcpGatewayGrant(grants, "2549ba75-2a91-4554-8baa-88e6ae0efa48", "send", true),
    ).toEqual({
      "a534b83f-a352-44d8-aedc-c4230c179390": ["read", "create", "send"],
      "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read", "send"],
    });
    expect(
      updateMcpGatewayGrant(
        { "2549ba75-2a91-4554-8baa-88e6ae0efa48": ["read"] },
        "2549ba75-2a91-4554-8baa-88e6ae0efa48",
        "read",
        false,
      ),
    ).toEqual({});
  });

  it("renders exact registry ids, reachability, and per-scope selections", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={[
          {
            environmentId: "a534b83f-a352-44d8-aedc-c4230c179390",
            label: "Primary",
            connectionState: "connected",
          },
          {
            environmentId: "2549ba75-2a91-4554-8baa-88e6ae0efa48",
            label: "JJ’s MacBook",
            connectionState: "connected",
          },
        ]}
        grants={grants}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Primary");
    expect(markup).toContain("a534b83f-a352-44d8-aedc-c4230c179390");
    expect(markup).toContain("JJ’s MacBook");
    expect(markup).toContain("2549ba75-2a91-4554-8baa-88e6ae0efa48");
    expect(markup).toContain("connected");
    expect(markup).toContain('aria-label="Grant read access to Primary"');
    expect(markup).toContain('aria-label="Grant create access to Primary"');
    expect(markup).toContain('aria-label="Grant send access to Primary"');
    expect(markup).toContain('data-checked=""');
  });

  it("keeps persisted grants for unregistered environments visible and revocable", () => {
    const markup = renderToStaticMarkup(
      <McpEnvironmentGrantMatrix
        environments={[]}
        grants={{ "removed-environment": ["read"] }}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Unavailable environment");
    expect(markup).toContain("removed-environment");
    expect(markup).toContain("unavailable");
    expect(markup).toContain('aria-label="Grant read access to Unavailable environment"');
    expect(markup).toContain('aria-label="Grant create access to Unavailable environment"');
    expect(markup).toContain('disabled=""');
  });
});
