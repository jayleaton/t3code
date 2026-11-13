import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PushRegistrations from "./PushRegistrations.ts";

const layer = PushRegistrations.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const insertSession = Effect.fn(function* (
  sessionId: string,
  input: { readonly expiresAt: string; readonly revokedAt?: string },
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
    VALUES (${sessionId}, 'phone', '[]', 'bearer-session-token', '2026-01-01T00:00:00.000Z',
      ${input.expiresAt}, ${input.revokedAt ?? null})
  `;
});

const token = (id: string) => `ExponentPushToken[${id}]`;

it.layer(layer)("PushRegistrations", (it) => {
  it.effect("keeps one row per install and per token, and drops rows of dead sessions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-13T00:00:00.000Z"));
      const store = yield* PushRegistrations.PushRegistrations;
      const live = AuthSessionId.make("live");
      const renewed = AuthSessionId.make("renewed");
      yield* insertSession("live", { expiresAt: "2999-01-01T00:00:00.000Z" });
      yield* insertSession("renewed", { expiresAt: "2999-01-01T00:00:00.000Z" });
      yield* insertSession("revoked", {
        expiresAt: "2999-01-01T00:00:00.000Z",
        revokedAt: "2026-01-02T00:00:00.000Z",
      });
      yield* insertSession("expired", { expiresAt: "2000-01-01T00:00:00.000Z" });

      // Re-registering the same install replaces its token and session.
      yield* store.register(live, { installId: "phone-a", expoPushToken: token("a1") });
      yield* store.register(renewed, { installId: "phone-a", expoPushToken: token("a2") });
      // A reinstall keeps the token under a new install id.
      yield* store.register(live, { installId: "phone-b", expoPushToken: token("b") });
      yield* store.register(live, { installId: "phone-b2", expoPushToken: token("b") });
      yield* store.register(AuthSessionId.make("revoked"), {
        installId: "phone-c",
        expoPushToken: token("c"),
      });
      yield* store.register(AuthSessionId.make("expired"), {
        installId: "phone-d",
        expoPushToken: token("d"),
      });

      assert.deepStrictEqual(yield* store.listDeliverable, [
        { installId: "phone-a", expoPushToken: token("a2") },
        { installId: "phone-b2", expoPushToken: token("b") },
      ]);
      const sql = yield* SqlClient.SqlClient;
      const remaining = yield* sql<{ id: string }>`
        SELECT install_id AS id FROM push_registrations ORDER BY install_id`;
      assert.deepStrictEqual(
        remaining.map((row) => row.id),
        ["phone-a", "phone-b2"],
      );

      yield* store.removeTokens([token("a2")]);
      yield* store.unregister("phone-b2");
      assert.deepStrictEqual(yield* store.listDeliverable, []);
    }),
  );
});
