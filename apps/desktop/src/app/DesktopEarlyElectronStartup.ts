import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
}

declare const __T3CODE_DESKTOP_BRAND__: string | undefined;
const desktopBrand =
  typeof __T3CODE_DESKTOP_BRAND__ === "undefined" ? "t3" : __T3CODE_DESKTOP_BRAND__;
type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput & { readonly brand?: string };

export interface EarlyLinuxElectronOptions {
  readonly isDevelopment: boolean;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

export const resolveLinuxDesktopEntryName = (
  isDevelopment: boolean,
  brand = desktopBrand,
): string =>
  brand === "agents"
    ? isDevelopment
      ? "com.jayleaton.t3agents.dev.desktop"
      : "com.jayleaton.t3agents.desktop"
    : isDevelopment
      ? "com.t3tools.T3Code.Development.desktop"
      : "com.t3tools.T3Code.desktop";

export const resolveLinuxWmClass = (isDevelopment: boolean, brand = desktopBrand): string =>
  `${brand === "agents" ? "t3agents" : "t3code"}${isDevelopment ? "-dev" : ""}`;

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

function resolveEarlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
}): string {
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const baseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
  });
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDevelopmentEnvironment(input.env),
    joinPath: input.joinPath,
    t3Home,
  });
  return input.joinPath(stateDir, "desktop-settings.json");
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  const settingsPath = resolveEarlyDesktopSettingsPath(input);
  try {
    const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
    return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
  } catch {
    return DEFAULT_LINUX_PASSWORD_STORE;
  }
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  const isDevelopment = isDevelopmentEnvironment(input.env);
  return {
    isDevelopment,
    linuxWmClass: resolveLinuxWmClass(isDevelopment, input.brand),
    linuxDesktopEntryName: resolveLinuxDesktopEntryName(isDevelopment, input.brand),
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
