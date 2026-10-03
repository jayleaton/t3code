/**
 * Command Code exposes session-local tools through --mod, but has no per-process
 * MCP config flag. Keep this module dependency-free so installed and bundled T3
 * servers can materialize it without changing the user's MCP configuration.
 * Credentials travel only in the child environment, never in the module file.
 */
export const COMMAND_CODE_MCP_MOD = String.raw`
export default async function t3Mcp(cmd) {
  const servers = JSON.parse(process.env.T3_COMMANDCODE_MCP_SERVERS || '[]');
  const connections = [];
  const close = async () => {
    await Promise.allSettled(connections.map(async (connection) => {
      if (connection.sessionId) await fetch(connection.url, {
        method: 'DELETE', headers: connection.headers(), signal: AbortSignal.timeout(5000),
      });
    }));
  };
  cmd.on('session_shutdown', close);
  try {
    for (const server of servers) {
      let nextId = 0;
      const connection = {
        url: server.url, sessionId: undefined, protocol: '2025-06-18',
        headers() {
          return {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            Authorization: server.authorizationHeader,
            'MCP-Protocol-Version': this.protocol,
            ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          };
        },
      };
      connections.push(connection);
      const request = async (method, params, signal, notification = false) => {
        const id = ++nextId;
        const response = await fetch(server.url, {
          method: 'POST', headers: connection.headers(),
          body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
          signal: AbortSignal.any([AbortSignal.timeout(method === 'tools/call' ? 300000 : 15000), ...(signal ? [signal] : [])]),
        });
        if (!response.ok) throw new Error(server.name + ' MCP ' + method + ' failed (HTTP ' + response.status + ')');
        connection.sessionId = response.headers.get('mcp-session-id') || connection.sessionId;
        if (notification) { await response.body?.cancel(); return; }
        let message;
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = '';
          try {
            while (!message) {
              const { value, done } = await reader.read();
              pending += decoder.decode(value, { stream: !done });
              let boundary;
              while ((boundary = /\r?\n\r?\n/.exec(pending))) {
                const frame = pending.slice(0, boundary.index);
                pending = pending.slice(boundary.index + boundary[0].length);
                const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (!data) continue;
                const candidate = JSON.parse(data);
                if (candidate.id === id) { message = candidate; break; }
              }
              if (done) break;
            }
          } finally { await reader.cancel(); }
        } else message = await response.json();
        if (!message || message.id !== id) throw new Error(server.name + ' MCP returned no matching response');
        if (message.error) throw new Error(server.name + ' MCP: ' + message.error.message);
        return message.result;
      };
      const initialized = await request('initialize', {
        protocolVersion: connection.protocol, capabilities: {},
        clientInfo: { name: 't3-commandcode', version: '1.0.0' },
      });
      connection.protocol = initialized.protocolVersion;
      await request('notifications/initialized', {}, undefined, true);
      let cursor;
      do {
        const page = await request('tools/list', cursor ? { cursor } : {});
        for (const tool of page.tools) {
          cmd.addTool({
            schema: {
              name: 'mcp__' + server.name.replace(/[^a-zA-Z0-9_]/g, '_') + '__' + tool.name,
              description: tool.description || tool.name,
              input_schema: { ...tool.inputSchema, type: 'object', properties: tool.inputSchema?.properties || {}, required: tool.inputSchema?.required || [] },
            },
            readOnly: tool.annotations?.readOnlyHint === true,
            run: async ({ input, signal }) => {
              try {
                const result = await request('tools/call', { name: tool.name, arguments: input }, signal);
                if (result.isError) return { ok: false, error: (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n') || 'MCP tool failed' };
                const content = (result.content || []).map(block => {
                  if (block.type === 'text') return { type: 'text', text: block.text };
                  if (block.type === 'image') return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
                  if (block.type === 'resource' && typeof block.resource?.text === 'string') return { type: 'text', text: block.resource.text };
                  return { type: 'text', text: JSON.stringify(block) };
                });
                if (!content.length && result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
                return { ok: true, content };
              } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
            },
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    process.stdout.write(JSON.stringify({ type: 'event', event: { type: 't3_mcp_ready' } }) + '\n');
  } catch (error) {
    await close();
    process.stdout.write(JSON.stringify({ type: 'event', event: { type: 't3_mcp_error', message: error instanceof Error ? error.message : String(error) } }) + '\n');
    throw error;
  }
}
`;
