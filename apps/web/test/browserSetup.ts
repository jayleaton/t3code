import { afterAll, beforeEach } from "vite-plus/test";
import { commands } from "vite-plus/test/browser";

declare module "vite-plus/test/browser" {
  interface BrowserCommands {
    /** Defined in vite.config.ts. Moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
    /** Defined in vite.config.ts. Runs a full V8 garbage collection in the test page, throttled. */
    collectGarbage: () => Promise<void>;
  }
}

// Playwright's mouse outlives each test and each file, so whatever the next test mounts
// under its last position starts hovered. Registered here rather than in render() so tests
// that mount without it are covered too. Before each test, not after: a timed-out test keeps
// running and can move the mouse after its own afterEach.
beforeEach(async () => {
  await commands.resetPointer();
});

// After each file, so earlier files' detached iframes release their shared memory before it
// starves the page's own sockets. See collectGarbage in vite.config.ts.
afterAll(async () => {
  await commands.collectGarbage();
});
