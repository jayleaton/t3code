import { expect, it, vi } from "vite-plus/test";
import { configureSharedEncryptionIdentity } from "./SharedSafeStorage.ts";

it.each(["darwin", "linux"])(
  "selects the shared encryption identity before startup on %s",
  (platform) => {
    const setName = vi.fn();
    configureSharedEncryptionIdentity({ platform, brand: "agents", isDevelopment: false, setName });
    expect(setName).toHaveBeenCalledExactlyOnceWith("t3code");
  },
);

it.each([
  { platform: "win32", brand: "agents", isDevelopment: false },
  { platform: "darwin", brand: "t3", isDevelopment: false },
  { platform: "linux", brand: "agents", isDevelopment: true },
])("preserves independent startup identities for $platform/$brand/dev=$isDevelopment", (input) => {
  const setName = vi.fn();
  configureSharedEncryptionIdentity({ ...input, setName });
  expect(setName).not.toHaveBeenCalled();
});
