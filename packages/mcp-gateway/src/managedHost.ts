import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Keeps one stdio gateway connected while the desktop gateway is enabled, so the shared owner
 * that external MCP clients attach to stays up even when none are connected.
 */
export async function createManagedGatewayHost(launch: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}) {
  const control = new Client({ name: "t3-desktop", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
    stderr: "pipe",
  });
  try {
    await control.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return { close: () => control.close() };
}
