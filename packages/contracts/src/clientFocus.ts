import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClientActivityClientId, ClientKind } from "./background.ts";

const FOCUS_PATH_MAX_LENGTH = 1024;

/** What a connected client should bring on screen. */
export const ClientFocusTarget = Schema.Union([
  Schema.TaggedStruct("thread", { threadId: ThreadId }),
  // Opens the thread with one file previewed beside it: images, video, PDF, or
  // code. A relative path resolves against the thread's workspace; an absolute
  // one may point anywhere the environment host can read.
  Schema.TaggedStruct("file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(FOCUS_PATH_MAX_LENGTH)),
    line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
  Schema.TaggedStruct("agents", {}),
]);
export type ClientFocusTarget = typeof ClientFocusTarget.Type;

/**
 * A client announces itself by holding a focus stream open. The stream is its
 * presence: a client is focusable exactly while the stream is connected.
 */
export const ClientFocusHost = Schema.Struct({
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  /** Human device name, e.g. the machine hostname or phone name. */
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** OS family such as "macos", "windows", "ios". */
  platform: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
});
export type ClientFocusHost = typeof ClientFocusHost.Type;

export const ClientFocusRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  target: ClientFocusTarget,
});
export type ClientFocusRequest = typeof ClientFocusRequest.Type;

export const ConnectedClient = Schema.Struct({
  clientId: ClientActivityClientId,
  clientKind: ClientKind,
  label: TrimmedNonEmptyString,
  platform: Schema.optionalKey(TrimmedNonEmptyString),
  /** Some window of this client is visible, or the app is in the foreground. */
  visible: Schema.Boolean,
  /** Some window of this client has input focus. */
  focused: Schema.Boolean,
  connectedAt: Schema.DateTimeUtc,
});
export type ConnectedClient = typeof ConnectedClient.Type;

export const ClientListResult = Schema.Struct({
  clients: Schema.Array(ConnectedClient),
});
export type ClientListResult = typeof ClientListResult.Type;

export const ClientFocusInput = Schema.Struct({
  clientId: ClientActivityClientId,
  target: ClientFocusTarget,
});
export type ClientFocusInput = typeof ClientFocusInput.Type;

export const ClientFocusResult = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  clientId: ClientActivityClientId,
  label: TrimmedNonEmptyString,
});
export type ClientFocusResult = typeof ClientFocusResult.Type;

export class ClientNotConnectedError extends Schema.TaggedError<ClientNotConnectedError>()(
  "ClientNotConnectedError",
  { clientId: ClientActivityClientId },
) {
  override get message(): string {
    return `Client ${this.clientId} is not connected to this environment.`;
  }
}
