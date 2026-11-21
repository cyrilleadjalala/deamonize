// checkpoint-only: needs G-B
/**
 * The compiled server fails closed (Requirements 11.2 to 11.5, 12.5, 15.3, 15.6, 30.3): approve runs the replay;
 * deny, timeout and a missing approver run zero steps; a read tool is never held. The program replayed is a small
 * terminal fixture (no Docker, no browser): a marker file shows whether a step ran.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Compiler } from '../../src/compiler/compiler.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { readAuditEntries } from '../../src/replay/runtime/audit-log.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { startApproverSim } from '../helpers/approver-sim.js';
import type { WorkflowSet } from '../../src/types.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const FAKE_SECRET = 'sk-test-0123456789abcdefFAKE';
let marker = '';
// The program writes a line to the marker file as soon as it starts: a replay that ran leaves it behind
let program = '';
const set = (): WorkflowSet => ({
  version: '1',
  targetType: 'tui',
  targetName: 'Fw Fixture',
  startCommand: [process.execPath, program],
  workflows: [
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      label: 'Change a record',
      steps: [
        { actionType: 'type', selectors: [], variable: 'api_token', label: 'Type the note', risk: 'write' },
        { actionType: 'keypress', selectors: [], value: 'Enter', risk: 'write' },
      ],
      variables: [{ name: 'api_token', description: 'A token' }],
      observedPayloads: [{ api_token: 'hello' }],
    },
    {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      label: 'Read a record',
      steps: [{ actionType: 'keypress', selectors: [], value: 'Enter', risk: 'read' }],
      variables: [],
      observedPayloads: [{}],
    },
  ],
});

describe('compiled server: the approval gate fails closed', () => {
  let out = '';
  let dataDir = '';
  let writeTool = '';
  let readTool = '';

  async function withServer<T>(env: Record<string, string>, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'firewall-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(out, 'mcp-server.js')],
      env: { ...(process.env as Record<string, string>), DAEMONIZE_DATA_DIR: dataDir, ...env },
      cwd: out,
    });
    await client.connect(transport);
    try {
      return await run(client);
    } finally {
      await closeClient(client, transport);
    }
  }
  const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
  };
  const lastEntry = async () => (await readAuditEntries(dataDir, { limit: 1 }))[0];

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'daemonize-fwe2e-'));
    dataDir = await mkdtemp(join(tmpdir(), 'daemonize-fwdata-'));
    marker = join(out, 'ran.txt');
    program = join(out, 'program.mjs');
    await writeFile(
      program,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n');\nprocess.stdin.on('data', () => {});\nconsole.log('ready');\nsetTimeout(() => process.exit(0), 600);\n`
    );
    const log = console.log;
    console.log = () => undefined;
    try {
      const compiled = await new Compiler().compile(new SchemaInferencer().inferWorkflows(set()), out);
      [writeTool, readTool] = ['Change a record', 'Read a record'].map((label) => {
        const id = label === 'Change a record' ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' : 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        return compiled.toolNames.get(id) as string;
      });
    } finally {
      console.log = log;
    }
    await symlink(join(workspaceRoot, 'node_modules'), join(out, 'node_modules'), 'junction');
  }, 60000);
  afterAll(async () => {
    for (const dir of [out, dataDir]) if (dir !== '') await removeDir(dir);
  });

  const askOn = { DAEMONIZE_ASK_BEFORE_CHANGES: 'true' };
  const reset = () => rm(marker, { force: true });

  it('approve: the replay runs and the entry says approved', async () => {
    await reset();
    const sim = await startApproverSim({ dataDir, decision: 'approved' });
    try {
      const result = await withServer(askOn, (client) => call(client, writeTool, { api_token: FAKE_SECRET }));
      expect(result.error).toBeUndefined();
    } finally {
      await sim.stop();
    }
    expect(existsSync(marker)).toBe(true);
    const entry = await lastEntry();
    expect(entry.decision).toBe('approved');
    expect(entry.tool).toBe(writeTool);
    expect(JSON.stringify(entry)).not.toContain(FAKE_SECRET);
  });

  it('deny: zero steps run', async () => {
    await reset();
    const sim = await startApproverSim({ dataDir, decision: 'denied' });
    try {
      const result = await withServer(askOn, (client) => call(client, writeTool, { api_token: 'x' }));
      expect(result.success).toBe(false);
      expect(result.error).toBe('approval_denied');
    } finally {
      await sim.stop();
    }
    expect(existsSync(marker)).toBe(false);
    expect((await lastEntry()).decision).toBe('denied');
  });

  it('timeout: nobody answers, zero steps run', async () => {
    await reset();
    const sim = await startApproverSim({ dataDir, decision: 'ignore' });
    try {
      const result = await withServer({ ...askOn, DAEMONIZE_APPROVAL_TIMEOUT_MS: '5000' }, (client) => call(client, writeTool, { api_token: 'x' }));
      expect(result.error).toBe('approval_timeout');
    } finally {
      await sim.stop();
    }
    expect(existsSync(marker)).toBe(false);
    expect((await lastEntry()).decision).toBe('timeout');
  });

  it('no approver: answers in under 5 s and runs zero steps', async () => {
    await reset();
    const started = Date.now();
    const result = await withServer(askOn, (client) => call(client, writeTool, { api_token: 'x' }));
    expect(Date.now() - started).toBeLessThan(5000 + 3000); // the 3 s allow for the start of the server
    expect(result.error).toBe('approval_unavailable');
    expect(existsSync(marker)).toBe(false);
    expect((await lastEntry()).decision).toBe('unavailable');
  });

  it('a read tool is never held, even with the setting on and nobody there', async () => {
    await reset();
    const result = await withServer(askOn, (client) => call(client, readTool, {}));
    expect(result.error).not.toBe('approval_unavailable');
    expect(existsSync(marker)).toBe(true);
    expect((await lastEntry()).decision).toBe('auto');
  });

  it('setting off: the call runs as before, with no trace in the result', async () => {
    await reset();
    const result = await withServer({}, (client) => call(client, writeTool, { api_token: 'x' }));
    expect(existsSync(marker)).toBe(true);
    expect(result.trace).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
    expect(await readFile(marker, 'utf-8')).toContain('ran');
  });
});
