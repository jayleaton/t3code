import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliInstallCommand,
  manualServerUpdateCommand,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it.each([
    [undefined, "t3 update 0.0.45"],
    [{ kind: "npx" } as const, "t3 update 0.0.45"],
    [{ kind: "npm-global", prefix: "/opt/node" } as const, "t3 update 0.0.45"],
    [{ kind: "linux-headless" } as const, "t3-headless-update install 0.0.45"],
  ])("updates an unmanaged %j server from the fork's releases", (installation, command) => {
    expect(manualServerUpdateCommand("0.0.45", installation)).toBe(command);
  });

  it("installs the CLI from the fork's install scripts", () => {
    expect(cliInstallCommand("posix", "1.2.3")).toBe(
      "curl -fsSL https://raw.githubusercontent.com/jayleaton/t3code/main/scripts/install.sh | T3CODE_VERSION=1.2.3 sh",
    );
    expect(cliInstallCommand("win32")).toBe(
      "irm https://raw.githubusercontent.com/jayleaton/t3code/main/scripts/install.ps1 | iex",
    );
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
