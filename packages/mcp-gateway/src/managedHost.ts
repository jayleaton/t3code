/* oxlint-disable unicorn/prefer-add-event-listener -- MCP transports use callback properties, not EventTarget. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

/** Owns stdio connections, preserving each managed agent's MCP session and notifications. */
export async function createManagedGatewayHost(
  launch: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  },
  emit: (event: { sessionId: string; message?: unknown; error?: string }) => void,
) {
  const transport = () =>
    new StdioClientTransport({
      command: launch.command,
      args: [...launch.args],
      env: { ...launch.env },
      stderr: "pipe",
    });
  const control = new Client({ name: "t3-desktop", version: "1.0.0" });
  const sessions = new Map<string, Promise<StdioClientTransport>>();
  let closed = false;
  const controlTransport = transport();
  try {
    await control.connect(controlTransport);
  } catch (error) {
    await controlTransport.close();
    throw error;
  }
  control.onclose = () => {
    if (!closed)
      emit({
        sessionId: "",
        error: "The MCP gateway disconnected. Disable and re-enable the gateway to reconnect.",
      });
  };
  const closeSession = async (sessionId: string) => {
    const pending = sessions.get(sessionId);
    sessions.delete(sessionId);
    await pending?.then(
      (session) => session.close(),
      () => undefined,
    );
  };
  return {
    async send(sessionId: string, message: unknown) {
      if (closed) throw new Error("MCP gateway is disabled.");
      let pending = sessions.get(sessionId);
      if (pending === undefined) {
        const session = transport();
        session.onmessage = (value) => emit({ sessionId, message: value });
        session.onerror = () => emit({ sessionId, error: "MCP gateway transport failed." });
        session.onclose = () => {
          if (sessions.get(sessionId) === pending) {
            sessions.delete(sessionId);
            emit({ sessionId, error: "MCP gateway session closed." });
          }
        };
        pending = session.start().then(
          () => session,
          async (error) => {
            await session.close();
            throw error;
          },
        );
        sessions.set(sessionId, pending);
      }
      await (await pending).send(JSONRPCMessageSchema.parse(message));
    },
    closeSession,
    async close() {
      closed = true;
      try {
        await Promise.all([...sessions.keys()].map(closeSession));
      } finally {
        await control.close();
      }
    },
  };
}
