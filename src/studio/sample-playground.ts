/**
 * The simulated server of the sample mode: it answers like a generated MCP server, with fixed fictitious results,
 * so the playground can be shown without an application. One result is drifted, two fail (one with a picture), and
 * heal mode turns the failing chart call into a healed success.
 *
 * The answers come from ui/js/sim/simulate.js, the one implementation the static demo also runs in the browser.
 * It plugs into the session as a connection, so the bridge code that runs against it is the real one.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectFn, Launch, McpConnection } from './playground.js';
import { SAMPLE_PNG, sampleStudioData } from './sample-data.js';
import { simulate, TIMEOUT_PROPERTY } from './ui/js/sim/simulate.js';

async function picture(folder: 'daemonize-failures' | 'daemonize-shots'): Promise<string> {
  const dir = join(tmpdir(), folder);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `sample-${Date.now()}-${randomBytes(3).toString('hex')}.png`);
  await writeFile(path, SAMPLE_PNG);
  return path;
}

export interface SampleTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function sampleTools(): SampleTool[] {
  const tools: SampleTool[] = [];
  for (const { set, outputs } of sampleStudioData().targets) {
    for (const workflow of set.workflows) {
      const name = outputs.nameMap?.[workflow.id];
      if (name === undefined) continue;
      const base = (workflow.inputSchema ?? { type: 'object' }) as Record<string, unknown>;
      const properties = { ...((base.properties as Record<string, unknown> | undefined) ?? {}), _timeoutMs: TIMEOUT_PROPERTY };
      tools.push({
        name,
        description: `${workflow.description ?? workflow.label}\n\nOptional reserved argument _timeoutMs (integer, 1 to 600000): timeout in milliseconds of the whole call; it is not part of the payload.`,
        inputSchema: { ...base, type: 'object', properties },
      });
    }
  }
  return tools;
}

/** The sample connection: a listing of the sample tools and the deterministic answers above. */
export const sampleConnect: ConnectFn = async (spec) => {
  const mode = spec.env.DAEMONIZE_MODE === 'heal' ? 'heal' : 'strict';
  const preview = spec.env.DAEMONIZE_SCREENSHOT === 'final';
  const tools = sampleTools();
  const pictures = { failure: () => picture('daemonize-failures'), shot: () => picture('daemonize-shots') };
  const listeners: Array<() => void> = [];
  let closed = false;
  const connection: McpConnection = {
    client: {
      listTools: async () => ({ tools }),
      callTool: async (params) => {
        if (closed) throw Object.assign(new Error('closed'), { code: -32000 });
        const result = await simulate(params.name, params.arguments ?? {}, mode, preview, pictures);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.success !== true };
      },
    },
    onClose: (listener) => {
      listeners.push(listener);
    },
    close: async () => {
      closed = true;
    },
    stderrTail: () => '',
  };
  return connection;
};

export const sampleLaunch = (): Launch => ({ command: 'sample', args: [], mcpEnv: {}, cwd: tmpdir() });
