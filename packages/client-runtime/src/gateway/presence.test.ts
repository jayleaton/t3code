import { AuthSessionId, RpcClientId, type ClientActivityLease } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { gatewayPresenceFromBackgroundPolicy } from "./runtimePort.ts";

const now = DateTime.makeUnsafe("2026-10-23T07:00:00.000Z");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function lease(
  input: Omit<Partial<ClientActivityLease>, "updatedAt" | "expiresAt"> & {
    updatedAt: string;
    expiresAt: string;
  },
) {
  return {
    sessionId: AuthSessionId.make("session"),
    rpcClientId: RpcClientId.make(1),
    clientId: "client",
    clientKind: "desktop-renderer",
    visible: false,
    focused: false,
    recentlyInteracted: false,
    scopes: [],
    ...input,
    updatedAt: at(input.updatedAt),
    expiresAt: at(input.expiresAt),
  } as ClientActivityLease;
}

describe("gatewayPresenceFromBackgroundPolicy", () => {
  it("is absent when no client holds a lease", () => {
    expect(gatewayPresenceFromBackgroundPolicy("local", { leases: [] }, now)).toEqual({
      environmentId: "local",
      present: false,
      anyVisible: false,
      anyFocused: false,
      anyRecentlyInteracted: false,
      lastActivityAt: null,
      clients: [],
      observedAt: "2026-10-23T07:00:00.000Z",
    });
  });

  it("is present when a live client is focused, with the latest report as last activity", () => {
    const presence = gatewayPresenceFromBackgroundPolicy(
      "local",
      {
        leases: [
          lease({
            visible: true,
            focused: true,
            recentlyInteracted: true,
            appState: "active",
            updatedAt: "2026-10-23T06:59:50.000Z",
            expiresAt: "2026-10-23T07:00:35.000Z",
          }),
          lease({
            clientKind: "mobile",
            updatedAt: "2026-10-23T06:59:55.000Z",
            expiresAt: "2026-10-23T07:00:40.000Z",
          }),
        ],
      },
      now,
    );
    expect(presence).toMatchObject({
      present: true,
      anyVisible: true,
      anyFocused: true,
      anyRecentlyInteracted: true,
      lastActivityAt: "2026-10-23T06:59:55.000Z",
    });
    expect(presence.clients.map((client) => client.clientKind)).toEqual([
      "desktop-renderer",
      "mobile",
    ]);
    expect(presence.clients[0]).not.toHaveProperty("sessionId");
  });

  it("ignores a focused lease that has already expired", () => {
    const presence = gatewayPresenceFromBackgroundPolicy(
      "local",
      {
        leases: [
          lease({
            visible: true,
            focused: true,
            updatedAt: "2026-10-23T06:58:00.000Z",
            expiresAt: "2026-10-23T06:58:45.000Z",
          }),
        ],
      },
      now,
    );
    expect(presence).toMatchObject({ present: false, lastActivityAt: null, clients: [] });
  });
});
