/**
 * `daemonize mcp [--workspace <dir>]`: the Studio_MCP over stdio. stdout carries MCP messages only, so `console.log` and
 * its siblings are rebound to stderr for the life of the command.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StudioConnection, resolveWorkspace } from '../../studio/mcp/connection.js';
import { createStudioMcpServer } from '../../studio/mcp/server.js';

export interface McpCommandOptions {
  workspace?: string;
}

/** The version of this package (the same for `daemonize --version` and the MCP server). */
export function packageVersion(): string {
  try {
    const text = readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8');
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function runMcpCommand(options: McpCommandOptions = {}): Promise<void> {
  const workspace = resolveWorkspace(options.workspace);
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`The workspace folder "${workspace}" does not exist.`);
  }
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => void console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  const api = new StudioConnection({ workspace });
  const server = createStudioMcpServer({ api, workspace, version: packageVersion() });
  const transport = new StdioServerTransport();
  try {
    await new Promise<void>((done, fail) => {
      let finished = false;
      const stop = (): void => {
        if (finished) return;
        finished = true;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        process.stdin.off('end', stop);
        process.stdin.off('close', stop);
        done();
      };
      server.onclose = stop;
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      process.stdin.once('end', stop);
      process.stdin.once('close', stop);
      server.connect(transport).catch((error: unknown) => {
        stop();
        fail(error);
      });
    });
  } finally {
    await server.close().catch(() => undefined);
    // A Studio this command started is stopped within 5 seconds; one it only attached to keeps running
    await api.close();
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
  }
}
