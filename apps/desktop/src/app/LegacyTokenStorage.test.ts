import { expect, it, vi } from "vite-plus/test";
import { withLegacyTokenStorage } from "./LegacyTokenStorage.ts";

function fixture() {
  const storage = {
    getItem: vi.fn(async (_key: string): Promise<string | null> => null),
    setItem: vi.fn(async (_key: string, _value: string) => {}),
    removeItem: vi.fn(async (_key: string) => {}),
  };
  const readEncrypted = vi.fn(async () => "enc:legacy-ciphertext");
  const decryptLegacy = vi.fn(async () => "fixture-token");
  return { storage, readEncrypted, decryptLegacy };
}

it("keeps current T3 credentials on the SDK path", async () => {
  const f = fixture();
  f.storage.getItem.mockResolvedValue("current-token");
  expect(await withLegacyTokenStorage(f).getItem("session")).toBe("current-token");
  expect(f.readEncrypted).not.toHaveBeenCalled();
});

it("recovers an earlier Agents token and persists it through the canonical encrypted SDK adapter", async () => {
  const f = fixture();
  expect(await withLegacyTokenStorage(f).getItem("session")).toBe("fixture-token");
  expect(f.decryptLegacy).toHaveBeenCalledWith("legacy-ciphertext");
  expect(f.storage.setItem).toHaveBeenCalledWith("session", "fixture-token");
});

it("does not delete or replace unreadable credentials", async () => {
  const f = fixture();
  f.decryptLegacy.mockRejectedValue(new Error("key unavailable"));
  expect(await withLegacyTokenStorage(f).getItem("session")).toBeNull();
  expect(f.storage.setItem).not.toHaveBeenCalled();
  expect(f.storage.removeItem).not.toHaveBeenCalled();
});

it("does not restore a token removed while legacy decryption was pending", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const decrypt = Promise.withResolvers<string>();
  f.decryptLegacy.mockImplementation(() => {
    started.resolve();
    return decrypt.promise;
  });
  const adapter = withLegacyTokenStorage(f);
  const read = adapter.getItem("session");
  await started.promise;
  await adapter.removeItem("session");
  decrypt.resolve("old-token");
  expect(await read).toBeNull();
  expect(f.storage.setItem).not.toHaveBeenCalled();
});

it("does not replace a refreshed token while legacy decryption was pending", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const decrypt = Promise.withResolvers<string>();
  f.decryptLegacy.mockImplementation(() => {
    started.resolve();
    return decrypt.promise;
  });
  const adapter = withLegacyTokenStorage(f);
  const read = adapter.getItem("session");
  await started.promise;
  await adapter.setItem("session", "new-token");
  f.storage.getItem.mockResolvedValue("new-token");
  decrypt.resolve("old-token");
  expect(await read).toBe("new-token");
  expect(f.storage.setItem).toHaveBeenCalledExactlyOnceWith("session", "new-token");
});
