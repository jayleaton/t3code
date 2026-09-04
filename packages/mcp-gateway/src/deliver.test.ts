import { describe, expect, it, vi } from "@effect/vitest";

import { createPinnedWebhookRequestOptions, resolveWebhookDestination } from "./deliver.ts";

const target = {
  url: "https://hooks.example.com/status?source=t3",
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

describe("webhook delivery network policy", () => {
  it("rejects a DNS answer set containing private addresses", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const },
    ]);

    await expect(resolveWebhookDestination(target.url, lookup)).rejects.toThrow(
      "public network destination",
    );
  });

  it("pins the validated DNS address and cannot follow redirects", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const destination = await resolveWebhookDestination(target.url, lookup);
    const options = createPinnedWebhookRequestOptions(target, destination);

    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "hooks.example.com",
      servername: "hooks.example.com",
      method: "POST",
      path: "/status?source=t3",
    });
    expect(options).not.toHaveProperty("maxRedirects");

    const pinnedLookup = options.lookup;
    if (typeof pinnedLookup !== "function") throw new Error("Expected a pinned lookup callback.");
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup("hooks.example.com", {}, (error, address, family) => {
        if (error !== null) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
  });
});
