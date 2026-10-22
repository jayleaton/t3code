import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    ssr: "src/bin.ts",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "t3-mcp-gateway.mjs",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // CI runs this config from the package, so the root 60s ceiling does not apply.
    // The shared gateway tests spawn real stdio sessions and detached owners.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
