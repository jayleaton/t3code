// Dependency-free so the Windows installer check in CI can run it without an install.

const LEGACY_FORK_WINDOWS_EXECUTABLE_NAME = "T3 Agents";

/** The packaged Windows exe's base name; the agents brand pins it across product renames. */
export function resolveWindowsExecutableName(productName: string, brand?: string): string {
  return brand === "agents" ? LEGACY_FORK_WINDOWS_EXECUTABLE_NAME : productName;
}

/**
 * NSIS names the uninstaller after electron-builder's productFilename, which is the exe name when
 * one is set, while shortcuts and the Apps entry follow the product name.
 */
export function resolveWindowsUninstallerName(productName: string, brand?: string): string {
  return `Uninstall ${resolveWindowsExecutableName(productName, brand)}.exe`;
}

if (import.meta.main) {
  const [productName, brand] = process.argv.slice(2);
  if (!productName) throw new Error("Usage: windows-package-names.ts <product name> [brand]");
  process.stdout.write(
    `${JSON.stringify({
      executable: `${resolveWindowsExecutableName(productName, brand)}.exe`,
      uninstaller: resolveWindowsUninstallerName(productName, brand),
    })}\n`,
  );
}
