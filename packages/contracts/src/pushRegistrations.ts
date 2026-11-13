import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** One phone app install; the same install registering again replaces its row. */
export const PushRegistrationInstallId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ExpoPushToken = TrimmedNonEmptyString.check(
  Schema.isPattern(/^Expo(nent)?PushToken\[[^\]]{1,256}\]$/),
);

export const PushRegistrationsRegisterInput = Schema.Struct({
  installId: PushRegistrationInstallId,
  expoPushToken: ExpoPushToken,
  label: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type PushRegistrationsRegisterInput = typeof PushRegistrationsRegisterInput.Type;

export const PushRegistrationsUnregisterInput = Schema.Struct({
  installId: PushRegistrationInstallId,
});
export type PushRegistrationsUnregisterInput = typeof PushRegistrationsUnregisterInput.Type;

export class PushRegistrationError extends Schema.TaggedError<PushRegistrationError>()(
  "PushRegistrationError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not save this device's notification registration.";
  }
}
