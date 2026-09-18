import { expect, it } from "vite-plus/test";
import { isLocalVoiceHost, selectVoiceDevice, isLoopbackVoiceUrl } from "./localDevice";
it("accepts the desktop host independently of remote pages", () => {
  expect(isLocalVoiceHost({ desktop: true, localEnabled: true, hostname: "remote.ts.net" })).toBe(
    true,
  );
  expect(isLocalVoiceHost({ desktop: true, localEnabled: false, hostname: "localhost" })).toBe(
    false,
  );
});
it("never treats a remote browser origin as this device", () => {
  for (const hostname of [
    "macbook.ts.net",
    "192.168.1.2",
    "localhost.example.com",
    "desktop.local",
  ]) {
    expect(isLocalVoiceHost({ desktop: false, localEnabled: true, hostname })).toBe(false);
  }
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    expect(isLocalVoiceHost({ desktop: false, localEnabled: true, hostname })).toBe(true);
  }
});

it("uses the paired loopback executor, never the remote page or an SSH forward", () => {
  const candidates = [
    { id: "remote", url: "https://desktop.ts.net", direct: true, connected: true, supported: true },
    { id: "local", url: "http://localhost:3773", direct: true, connected: true, supported: true },
    { id: "ssh", url: "http://localhost:4444", direct: false, connected: true, supported: true },
  ];
  expect(selectVoiceDevice(candidates)).toBe("local");
  expect(selectVoiceDevice(candidates.map((c) => ({ ...c, supported: false })))).toBeNull();
  expect(selectVoiceDevice(candidates.map((c) => ({ ...c, connected: false })))).toBeNull();
  expect(selectVoiceDevice([...candidates, { ...candidates[1]!, id: "second" }])).toBeNull();
});

it("rejects deceptive loopback URLs before pairing", () => {
  for (const url of [
    "http://localhost.evil.test",
    "http://localhost@evil.test",
    "file://localhost/test",
    "nonsense",
  ]) {
    expect(isLoopbackVoiceUrl(url)).toBe(false);
  }
  expect(isLoopbackVoiceUrl("http://127.0.0.1:3773/pair#token=test")).toBe(true);
});
