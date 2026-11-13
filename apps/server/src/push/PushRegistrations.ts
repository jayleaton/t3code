import {
  PushRegistrationError,
  type AuthSessionId,
  type PushRegistrationsRegisterInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export interface PushTarget {
  readonly installId: string;
  readonly expoPushToken: string;
}

export class PushRegistrations extends Context.Service<
  PushRegistrations,
  {
    readonly register: (
      sessionId: AuthSessionId,
      input: PushRegistrationsRegisterInput,
    ) => Effect.Effect<void, PushRegistrationError>;
    readonly unregister: (installId: string) => Effect.Effect<void, PushRegistrationError>;
    /** Phones whose session is still live. Rows of revoked or expired sessions are deleted. */
    readonly listDeliverable: Effect.Effect<ReadonlyArray<PushTarget>, PushRegistrationError>;
    /** Expo reported these tokens as no longer registered on their device. */
    readonly removeTokens: (
      tokens: ReadonlyArray<string>,
    ) => Effect.Effect<void, PushRegistrationError>;
  }
>()("t3/push/PushRegistrations") {}

const toError = (cause: unknown) => new PushRegistrationError({ cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const register = Effect.fn("PushRegistrations.register")(function* (
    sessionId: AuthSessionId,
    input: PushRegistrationsRegisterInput,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // A reinstall keeps the token but gets a new install id; one phone, one row.
          yield* sql`DELETE FROM push_registrations
            WHERE expo_push_token = ${input.expoPushToken} AND install_id <> ${input.installId}`;
          yield* sql`
            INSERT INTO push_registrations (install_id, session_id, expo_push_token, label, updated_at)
            VALUES (${input.installId}, ${sessionId}, ${input.expoPushToken}, ${input.label ?? null}, ${now})
            ON CONFLICT (install_id) DO UPDATE SET
              session_id = excluded.session_id,
              expo_push_token = excluded.expo_push_token,
              label = excluded.label,
              updated_at = excluded.updated_at
          `;
        }),
      )
      .pipe(Effect.mapError(toError));
  });

  const unregister = Effect.fn("PushRegistrations.unregister")(function* (installId: string) {
    yield* sql`DELETE FROM push_registrations WHERE install_id = ${installId}`.pipe(
      Effect.mapError(toError),
    );
  });

  const listDeliverable = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      DELETE FROM push_registrations
      WHERE session_id NOT IN (
        SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ${now}
      )
    `;
    return yield* sql<PushTarget>`
      SELECT install_id AS "installId", expo_push_token AS "expoPushToken"
      FROM push_registrations
      ORDER BY install_id
    `;
  }).pipe(Effect.mapError(toError), Effect.withSpan("PushRegistrations.listDeliverable"));

  const removeTokens = Effect.fn("PushRegistrations.removeTokens")(function* (
    tokens: ReadonlyArray<string>,
  ) {
    if (tokens.length === 0) return;
    yield* sql`DELETE FROM push_registrations WHERE ${sql.in("expo_push_token", tokens)}`.pipe(
      Effect.mapError(toError),
    );
  });

  return PushRegistrations.of({ register, unregister, listDeliverable, removeTokens });
});

export const layer = Layer.effect(PushRegistrations, make);
