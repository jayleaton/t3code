import type { TokenStorage } from "@clerk/electron";

/** Read old Agents tokens without changing the SDK's encryption or persistence policy. */
export function withLegacyTokenStorage(input: {
  storage: TokenStorage;
  readEncrypted: (key: string) => Promise<string | undefined>;
  decryptLegacy: (ciphertext: string) => Promise<string>;
}): TokenStorage {
  const versions = new Map<string, number>();
  const mutate = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1);
  return {
    async getItem(key) {
      const version = versions.get(key);
      const current = await input.storage.getItem(key);
      if (current !== null && current !== undefined) return current;
      try {
        const encrypted = await input.readEncrypted(key);
        if (!encrypted?.startsWith("enc:")) return null;
        const value = await input.decryptLegacy(encrypted.slice(4));
        // Sign-out or a refreshed token may have overtaken the compatibility read.
        if (versions.get(key) !== version) return input.storage.getItem(key);
        await input.storage.setItem(key, value);
        return versions.get(key) === version ? value : input.storage.getItem(key);
      } catch {
        // Keep an unreadable credential intact, matching Clerk's normal behavior.
        return null;
      }
    },
    setItem(key, value) {
      mutate(key);
      return input.storage.setItem(key, value);
    },
    removeItem(key) {
      mutate(key);
      return input.storage.removeItem(key);
    },
  };
}
