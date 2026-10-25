// Calls one tool on the T3 MCP gateway the way an MCP host does: start the gateway launcher
// with stdio, initialize, call the tool, print the result. Exits non-zero on an error result
// or after 30 s. Run it with the runtime that runs the gateway:
//
//   ELECTRON_RUN_AS_NODE=1 <app>/t3code t3-gateway-call.mjs <app>/resources/t3-mcp-gateway.mjs \
//     t3_get_gateway_health '{}'
//
// The launcher reads T3_MCP_BRIDGE_TOKEN, T3_MCP_BRIDGE_PORT and T3_MCP_STATE_FILE from the
// environment, so pass the same values as the gateway service.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

const [gatewayEntry, tool, rawArgs = "{}"] = process.argv.slice(2);
if (!gatewayEntry || !tool) {
  process.stderr.write("usage: t3-gateway-call.mjs <t3-mcp-gateway.mjs> <tool> [json-args]\n");
  process.exit(2);
}

const child = NodeChildProcess.spawn(process.execPath, [gatewayEntry], {
  stdio: ["pipe", "pipe", "inherit"],
});
const fail = (message) => {
  process.stderr.write(`t3-gateway-call: ${message}\n`);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail(`no answer from ${tool} within 30 s`), 30_000);
child.on("exit", (code) => fail(`gateway launcher exited (${code}) before answering`));

const pending = new Map();
NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});

let nextId = 1;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "t3-gateway-call", version: "1" },
});
if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const reply = await request("tools/call", { name: tool, arguments: JSON.parse(rawArgs) });
clearTimeout(timer);
child.removeAllListeners("exit");
child.kill();
if (reply.error) fail(`${tool} failed: ${JSON.stringify(reply.error)}`);
const text = (reply.result?.content ?? []).map((part) => part.text ?? "").join("\n");
process.stdout.write(`${text}\n`);
process.exit(reply.result?.isError ? 1 : 0);
