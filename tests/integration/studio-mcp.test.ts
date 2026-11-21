// checkpoint-only: needs G-B, G-D
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { studio as startStudioCommand } from '../../src/cli/commands/studio.js';
import { compile } from '../../src/cli/commands/compile.js';
import { leasePath } from '../../src/studio/lease.js';
import { StudioConnection } from '../../src/studio/mcp/connection.js';
import { createStudioMcpServer } from '../../src/studio/mcp/server.js';
import { STUDIO_MCP_TOOL_NAMES } from '../../src/studio/mcp/tool-names.js';
import { requestApproval } from '../../src/replay/runtime/approval-queue.js';
import type { StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { startApproverSim } from '../helpers/approver-sim.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');
// A fictitious value in the shape of a credential, built at run time
const PLANTED = ['sk', 'integration', 'Zx81Qm4Lp9Tr2Vw7Yb'].join('-');

const greetSteps = (risk: 'read' | 'write') => [
  { actionType: 'type' as const, selectors: [], variable: 'your_name', label: 'Type at "Your name"' },
  { actionType: 'keypress' as const, selectors: [], value: 'Enter' },
  { actionType: 'type' as const, selectors: [], value: '1' },
  { actionType: 'keypress' as const, selectors: [], value: 'Enter', risk },
];

const terminalSet: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'Greeter',
  startCommand: [process.execPath, greeter],
  workflows: [
    { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'Greet someone', steps: greetSteps('read'), variables: [{ name: 'your_name', description: 'Your name' }], observedPayloads: [{ your_name: 'Ada' }] },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', label: 'Greet and save', steps: greetSteps('write'), variables: [{ name: 'your_name', description: 'Your name' }], observedPayloads: [{ your_name: 'Ada' }] },
  ],
};

describe('Studio_MCP against a real Studio', () => {
  let dir: string;
  let dataDir: string;
  let handle: StudioHandle;
  let client: Client;
  let api: StudioConnection;
  let readTool = '';
  let writeTool = '';
  const saved: Record<string, string | undefined> = {};
  const answers: string[] = [];

  const call = async (name: string, args?: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const text = result.content.map((c) => c.text).join('');
    answers.push(text);
    return { isError: result.isError === true, text, json: JSON.parse(text) as Record<string, any> };
  };
  const raw = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${handle.origin}${path}`, {
      method,
      headers: { 'x-studio-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(workspaceRoot, '.mcp-int-'));
    dataDir = await mkdtemp(join(tmpdir(), 'dz-mcp-int-data-'));
    const file = join(dir, 'workflows.json');
    await writeFile(file, serializeWorkflowSet(terminalSet));
    const out = join(dir, 'out');
    const log = console.log;
    console.log = () => undefined;
    try {
      await compile(file, out);
    } finally {
      console.log = log;
    }
    // The Studio command reads the environment of this process: the data folder is a temporary one, and one secret is planted
    for (const name of ['DAEMONIZE_DATA_DIR', 'DAEMONIZE_SECRET_X']) saved[name] = process.env[name];
    process.env.DAEMONIZE_DATA_DIR = dataDir;
    process.env.DAEMONIZE_SECRET_X = PLANTED;
    // The real command: it writes the lease for this folder before it would print the handshake line
    handle = await startStudioCommand(out, { workflows: file, machine: true, stdout: () => undefined, stderr: () => undefined });

    api = new StudioConnection({ workspace: process.cwd(), dataDir });
    const server = createStudioMcpServer({
      api,
      workspace: process.cwd(),
      requestApproval,
      approvalTimeoutMs: () => 20_000,
      dataDir: () => dataDir,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'integration', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  }, 180000);

  afterAll(async () => {
    await client?.close();
    await api?.close();
    await handle?.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (dir) await removeDir(dir);
    if (dataDir) await removeDir(dataDir);
  });

  it('attaches through the lease of the real Studio, which holds the agent token and never the owner token', async () => {
    const path = leasePath(dataDir, process.cwd());
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain(handle.agentToken);
    expect(text).not.toContain(handle.token);
    const listed = await call('list_actions');
    expect(listed.isError).toBe(false);
    const actions = listed.json.actions as Array<{ tool: string | null; risk: string; label: string }>;
    expect(actions).toHaveLength(2);
    readTool = actions.find((x) => x.risk === 'read')!.tool!;
    writeTool = actions.find((x) => x.risk !== 'read')!.tool!;
    expect(readTool).toBeTruthy();
    expect(writeTool).toBeTruthy();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...STUDIO_MCP_TOOL_NAMES]);
  });

  it('refuses the agent token on every route that decides, stores a secret or changes the setting', async () => {
    const forbidden: Array<[string, string, unknown?]> = [
      ['POST', '/api/approvals/decide', { id: 'a'.repeat(32), decision: 'approved' }],
      ['GET', '/api/approvals'],
      ['POST', '/api/secrets', { name: 'X', value: 'whatever-value' }],
      ['POST', '/api/secrets/forget', { name: 'X' }],
      ['POST', '/api/power/approval', { scope: 'global', askBeforeChanges: false }],
      ['POST', '/api/power/remove', { scope: 'global' }],
      ['POST', '/api/pbt/run'],
    ];
    for (const [method, path, body] of forbidden) {
      const response = await raw(method, path, handle.agentToken, body ?? (method === 'POST' ? {} : undefined));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.text()).toContain('needs you, not an assistant');
    }
    // The same call with the owner token gets past the guard (it may answer 4xx for its own reasons, never 403 for the agent)
    expect((await raw('GET', '/api/approvals', handle.token)).status).toBe(200);
  });

  it('enforces confirmation_required, in the tool and in the Studio', async () => {
    const result = await call('test_action', { tool: writeTool, arguments: { your_name: 'Ada' } });
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('confirmation_required');
    const direct = await raw('POST', '/api/playground/call', handle.agentToken, { tool: writeTool, arguments: { your_name: 'Ada' } });
    expect(direct.status).toBe(409);
    expect(await direct.text()).toContain('confirmation_required');
  });

  it('runs a read tool with no question', async () => {
    const result = await call('test_action', { tool: readTool, arguments: { your_name: 'Ada' } });
    expect(result.isError).toBe(false);
    expect(result.json, result.text).toMatchObject({ success: true });
  });

  it('waits for the human: approved runs the tool, denied and no answer run nothing', async () => {
    // Approved after a short delay
    const approver = await startApproverSim({ dataDir, decision: 'approved', delayMs: 300 });
    try {
      const approved = await call('test_action', { tool: writeTool, arguments: { your_name: PLANTED }, confirm: true });
      expect(approved.isError).toBe(false);
      expect(approved.json.success).toBe(true);
      expect(approver.seen).toHaveLength(1);
      expect(approver.seen[0]).toMatchObject({ source: 'studio-mcp', kind: 'test-action', tool: writeTool, risk: 'write' });
      // The planted value was typed as an argument: the request, the answer and the files hold no value of it
      expect(JSON.stringify(approver.seen[0])).not.toContain(PLANTED);
      expect(approved.text).not.toContain(PLANTED);
    } finally {
      await approver.stop();
    }
    const denier = await startApproverSim({ dataDir, decision: 'denied' });
    try {
      const denied = await call('test_action', { tool: writeTool, arguments: { your_name: 'Ada' }, confirm: true });
      expect(denied.json.error).toBe('approval_denied');
      expect(denier.seen).toHaveLength(1);
    } finally {
      await denier.stop();
    }
    // Nobody there: the Studio of this test also keeps a heartbeat, so the question is asked and left unanswered until it ends
    const silent = await startApproverSim({ dataDir, decision: 'ignore' });
    try {
      const shortApi = createStudioMcpServer({
        api,
        workspace: process.cwd(),
        requestApproval,
        approvalTimeoutMs: () => 5_000,
        dataDir: () => dataDir,
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const quick = new Client({ name: 'quick', version: '1.0.0' });
      await Promise.all([shortApi.connect(a), quick.connect(b)]);
      const result = (await quick.callTool({ name: 'test_action', arguments: { tool: writeTool, confirm: true } })) as { content: Array<{ text: string }> };
      expect(JSON.parse(result.content[0]!.text).error).toBe('approval_timeout');
      await quick.close();
    } finally {
      await silent.stop();
    }
  });

  it('the files of the approval queue hold no secret value and no token', () => {
    const approvals = join(dataDir, 'approvals');
    for (const name of readdirSync(approvals)) {
      if (name === '.key') continue;
      const text = readFileSync(join(approvals, name), 'utf-8');
      expect(text, name).not.toContain(PLANTED);
      expect(text, name).not.toContain(handle.agentToken);
      expect(text, name).not.toContain(handle.token);
    }
  });

  it('no answer of any tool holds the planted secret, the tokens or the address', async () => {
    await call('list_credentials');
    await call('get_activity');
    await call('get_recording_status');
    await call('get_action', { id: 'unknown' });
    await call('test_action', { tool: readTool, arguments: { your_name: PLANTED } });
    await call('preview_kiro_install', { scope: 'global' });
    expect(answers.length).toBeGreaterThan(8);
    for (const text of answers) {
      expect(text).not.toContain(PLANTED);
      expect(text).not.toContain(handle.agentToken);
      expect(text).not.toContain(handle.token);
      expect(text).not.toContain(handle.origin);
      expect(text).not.toMatch(/\n\s+at\s+\S+.*:\d+:\d+/);
    }
  });
});
