// A tiny MCP server over stdio for the Studio secrets tests. Tool `whoami` answers the first 12 hex characters of the
// SHA-256 of DAEMONIZE_SECRET_PW (never the value), so a test can tell which value the process was started with.
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'env-probe', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'whoami', description: 'Hash of the secret', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  const value = process.env.DAEMONIZE_SECRET_PW ?? '';
  const text = value === '' ? 'none' : createHash('sha256').update(value).digest('hex').slice(0, 12);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, text }) }] };
});
await server.connect(new StdioServerTransport());
