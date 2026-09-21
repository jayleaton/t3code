// @effect-diagnostics nodeBuiltinImport:off - deterministic native-format encryption fixture.
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import {
  configureSharedEncryptionIdentity,
  validateNativeDecryption,
} from "./SharedSafeStorage.ts";

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

it("rejects a wrong Linux key that passes CBC padding, allowing legacy decryption", () => {
  // This fixed ciphertext encrypts fixture-102 with key 0x01. Decrypting with
  // key 0x00 happens to pass PKCS#7 padding but produces invalid UTF-8.
  const encrypted = Buffer.from("d751538a1f8fee81d736e7dfaf587caa", "hex");
  const ciphertext = Buffer.concat([Buffer.from("v11"), encrypted]);
  const decrypt = (key: number) => {
    const cipher = NodeCrypto.createDecipheriv(
      "aes-128-cbc",
      Buffer.alloc(16, key),
      Buffer.alloc(16, 32),
    );
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8");
  };
  const encrypt = (key: number) => (text: string) => {
    const cipher = NodeCrypto.createCipheriv(
      "aes-128-cbc",
      Buffer.alloc(16, key),
      Buffer.alloc(16, 32),
    );
    return Buffer.concat([Buffer.from("v11"), cipher.update(text), cipher.final()]);
  };
  expect(() => validateNativeDecryption(ciphertext, decrypt(0), "linux", encrypt(0))).toThrow(
    "invalid UTF-8",
  );
  expect(validateNativeDecryption(ciphertext, decrypt(1), "linux", encrypt(1))).toBe("fixture-102");
});

it("preserves genuine replacement characters and does not validate other encryption formats", () => {
  const ciphertext = Buffer.from("v11original ciphertext");
  const encrypt = vi.fn(() => ciphertext);
  expect(validateNativeDecryption(ciphertext, "valid \uFFFD text", "linux", encrypt)).toBe(
    "valid \uFFFD text",
  );
  expect(encrypt).toHaveBeenCalledExactlyOnceWith("valid \uFFFD text");
  encrypt.mockClear();
  for (const platform of ["darwin", "win32"]) {
    expect(validateNativeDecryption(ciphertext, "\uFFFD", platform, encrypt)).toBe("\uFFFD");
  }
  expect(validateNativeDecryption(Buffer.from("v10legacy"), "\uFFFD", "linux", encrypt)).toBe(
    "\uFFFD",
  );
  expect(validateNativeDecryption(ciphertext, "normal credential", "linux", encrypt)).toBe(
    "normal credential",
  );
  expect(encrypt).not.toHaveBeenCalled();
});
