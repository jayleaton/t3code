/* oxlint-disable unicorn/prefer-add-event-listener -- MCP clients expose callback properties. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

const REASON_PREFIX = "t3-mcp-gateway: ";
const MAX_LINE_LENGTH = 4_096;

/**
 * The launcher reports why it could not start only on stderr, as `t3-mcp-gateway: <reason>`.
 * Chunks are not lines, so stderr is framed into whole lines; an oversized line is skipped.
 */
function launcherReason(transport: StdioClientTransport): () => string | undefined {
  let reason: string | undefined;
  let partial = "";
  let skipping = false;
  const take = (line: string) => {
    if (line.startsWith(REASON_PREFIX)) reason = line.slice(REASON_PREFIX.length).trimEnd();
  };
  // A multi-byte character can also span chunks.
  const decoder = new TextDecoder();
  transport.stderr?.on("data", (chunk: Uint8Array) => {
    const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!skipping) take(line);
      skipping = false;
    }
    if (partial.length > MAX_LINE_LENGTH) {
      partial = "";
      skipping = true;
    }
  });
  return () => {
    if (!skipping) take(partial);
    return reason;
  };
}

/** Keeps the desktop's gateway session alive, including after a launcher exits or stops replying. */
export async function createManagedGatewayHost(launch: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}) {
  let stopped = false;
  let timer: Fiber.Fiber<void, never> | undefined;
  let connecting: Promise<void> | undefined;
  let active: { control: Client; transport: StdioClientTransport } | undefined;
  // Each relaunch starts a runtime process; a persistent rejection must not respawn every second.
  let failures = 0;

  const schedule = (run: () => void, delay: number) => {
    timer?.interruptUnsafe();
    if (stopped) return;
    timer = Effect.runFork(Effect.sleep(delay).pipe(Effect.tap(() => Effect.sync(run))));
  };
  const recover = () => {
    if (stopped || connecting) return;
    connecting = (async () => {
      const previous = active;
      active = undefined;
      await previous?.control.close();
      if (!stopped) await connect();
      failures = 0;
    })()
      .catch(() => {
        // A temporarily unavailable executable or owner must not disable an enabled gateway.
        failures += 1;
        schedule(recover, Math.min(1_000 * 2 ** (failures - 1), 30_000));
      })
      .finally(() => {
        connecting = undefined;
      });
  };
  const check = () => {
    const current = active;
    if (stopped || current === undefined) return;
    void current.control.ping({ timeout: 5_000 }).then(
      () => {
        if (active === current) schedule(check, 15_000);
      },
      () => {
        if (active === current) schedule(recover, 1_000);
      },
    );
  };
  const connect = async () => {
    const control = new Client({ name: "t3-desktop", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      env: { ...launch.env },
      stderr: "pipe",
    });
    const reason = launcherReason(transport);
    const current = { control, transport };
    active = current;
    let closed = false;
    control.onclose = () => {
      closed = true;
      if (active === current) schedule(recover, 1_000);
    };
    try {
      await control.connect(transport, { timeout: 15_000 });
      if (closed || stopped) throw new Error("Gateway connection closed during startup.");
      schedule(check, 15_000);
    } catch (error) {
      if (active === current) active = undefined;
      await transport.close();
      const message = reason();
      throw message === undefined ? error : new Error(message, { cause: error });
    }
  };

  try {
    await connect();
  } catch (error) {
    stopped = true;
    timer?.interruptUnsafe();
    throw error;
  }
  return {
    close: async () => {
      stopped = true;
      timer?.interruptUnsafe();
      const current = active;
      active = undefined;
      await current?.transport.close();
      await connecting;
    },
  };
}
