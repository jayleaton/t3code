import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_BUILD_VERSION__: string | undefined;

// Source runs use the package version; packaged clients and servers share the
// release version supplied to the build, even when manifests have not been bumped.
export const serverBuildVersion =
  typeof __T3CODE_BUILD_VERSION__ === "undefined" ? packageJson.version : __T3CODE_BUILD_VERSION__;
