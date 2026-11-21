import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StudioConnection } from '../../src/studio/mcp/connection';
import { createStudioMcpServer } from '../../src/studio/mcp/server';
import { STUDIO_MCP_TOOL_NAMES } from '../../src/studio/mcp/tool-names';
import { describeTools } from '../../src/studio/mcp/schemas';
import type { ApprovalOutcome, RequestApprovalOptions } from '../../src/replay/runtime/approval-queue';
import { leaseFor, startFakeStudio, type FakeStudio } from '../helpers/fake-studio';

// Fictitious values built at run time: none is a real credential
const SECRET = ['sk', 'fake', 'AbCdEf0123456789QrStUv'].join('-');
const ENV = { DAEMONIZE_SECRET_PASSWORD: SECRET } as NodeJS.ProcessEnv;

interface Harness {
  studio: FakeStudio;
  workspace: string;
  dataDir: string;
  client: Client;
  asked: RequestApprovalOptions[];
  decision: { value: ApprovalOutcome['decision'] };
  call(name: string, args?: unknown): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function harness(options: { homeIsWorkspace?: boolean } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dz-mcp-'));
  const workspace = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(workspace);
  mkdirSync(dataDir);
  const studio = await startFakeStudio();
  await leaseFor(dataDir, workspace, studio);
  const api = new StudioConnection({ workspace, dataDir, env: ENV });
  const asked: RequestApprovalOptions[] = [];
  const decision: { value: ApprovalOutcome['decision'] } = { value: 'approved' };
  const server = createStudioMcpServer({
    api,
    workspace,
    env: ENV,
    requestApproval: async (o) => {
      asked.push(o);
      return { decision: decision.value };
    },
    approvalTimeoutMs: () => 5000,
    dataDir: () => dataDir,
    sleep: async () => undefined,
    ...(options.homeIsWorkspace === true ? { home: workspace } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    studio,
    workspace,
    dataDir,
    client,
    asked,
    decision,
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args as Record<string, unknown> | undefined })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      const text = result.content.map((c) => c.text).join('');
      return { isError: result.isError === true, text, json: JSON.parse(text) as Record<string, unknown> };
    },
    async close() {
      await client.close();
      await api.close();
      await studio.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('Studio_MCP tool list', () => {
  let h: Harness;
  beforeEach(async () => (h = await harness()));
  afterEach(async () => h.close());

  it('lists exactly the thirteen tools, with valid names and closed schemas', async () => {
    const listed = await h.client.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual([...STUDIO_MCP_TOOL_NAMES]);
    for (const tool of listed.tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.description && tool.description.length).toBeGreaterThan(10);
      expect((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
    // Every nested object that lists properties is closed too (`arguments` of test_action is the tool's own open object)
    const open: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      if (schema.type === 'object' && schema.properties !== undefined && schema.additionalProperties !== false) open.push(path);
      for (const [k, v] of Object.entries(schema)) walk(v, `${path}.${k}`);
    };
    for (const tool of describeTools()) walk(tool.inputSchema, tool.name);
    expect(open).toEqual([]);
    expect(h.studio.count()).toBe(0);
  });

  it('exposes no tool or field that accepts a secret value, approves, or changes the setting', async () => {
    const names = STUDIO_MCP_TOOL_NAMES.join(' ');
    expect(names).not.toMatch(/approv|decid|secret|vault|forget|setting|remove/);
    const fields = JSON.stringify(describeTools().map((t) => Object.keys((t.inputSchema.properties as object) ?? {})));
    expect(fields).not.toMatch(/password|secret|token|value/i);
  });
});

describe('Studio_MCP refuses bad arguments before any request', () => {
  let h: Harness;
  beforeEach(async () => (h = await harness()));
  afterEach(async () => h.close());

  const cases: Array<[string, unknown, string]> = [
    ['list_actions', { extra: 1 }, 'extra'],
    ['get_action', { id: 'wf-read', surprise: true }, 'surprise'],
    ['get_action', {}, 'id'],
    ['get_activity', { limit: 0 }, 'limit'],
    ['get_activity', { limit: 101 }, 'limit'],
    ['get_activity', { limit: 1.5 }, 'limit'],
    ['start_recording', { name: 'x', url: 'https://example.com', password: 'nope' }, 'password'],
    ['compile', { http: 'always' }, 'http'],
    ['test_action', { tool: 'add_customer', timeoutMs: 600001 }, 'timeoutMs'],
    ['preview_kiro_install', { scope: 'everywhere' }, 'scope'],
    ['install_to_kiro', { scope: 'global' }, 'confirmationId'],
    ['update_action', { id: 'wf-read', confirm: true, variables: [{ name: 'a', hidden: 1 }] }, 'variables.0.hidden'],
    ['delete_action', { id: 'wf-read', approve: true }, 'approve'],
  ];
  for (const [tool, args, field] of cases) {
    it(`${tool} ${JSON.stringify(args)} names ${field} and sends nothing`, async () => {
      const result = await h.call(tool, args);
      expect(result.isError).toBe(true);
      expect(['unknown_field', 'invalid_argument']).toContain(result.json.error);
      expect(String(result.json.field)).toBe(field);
      expect(h.studio.count()).toBe(0);
      expect(h.asked).toEqual([]);
    });
  }

  it('refuses an unknown tool name', async () => {
    const result = await h.call('approve_request', {});
    expect(result.isError).toBe(true);
    expect(h.studio.count()).toBe(0);
  });
});

describe('Studio_MCP answers hold no secret, path, address, token or stack', () => {
  let h: Harness;
  beforeEach(async () => (h = await harness()));
  afterEach(async () => h.close());

  const forbidden = (): RegExp[] => [new RegExp(SECRET.replace(/[-]/g, '\\-')), /\n\s+at\s+\S+\s+\(/, /127\.0\.0\.1/, /x-studio-token/i];

  it('scrubs a planted secret from every answer, including Studio error bodies', async () => {
    const leak = `value ${SECRET} inside`;
    h.studio.set('GET /api/workflows', { status: 200, body: { workflows: [{ id: 'wf', label: leak, description: leak, risk: { highest: 'read' }, variables: [], steps: [{ label: leak }], writeSteps: [] }] } });
    h.studio.set('GET /api/secrets', { status: 500, body: { error: leak } });
    h.studio.set('GET /api/activity', { status: 200, body: { entries: [{ tool: 't', outcome: leak, arguments: { note: leak } }] } });
    h.studio.set('GET /api/record/status', { status: 200, body: { state: 'error', steps: 1, labels: [leak], error: leak } });
    h.studio.set('POST /api/playground/call', { status: 200, body: { success: true, text: leak, data: { a: leak }, error: leak, message: leak } });
    const answers = [
      await h.call('list_actions'),
      await h.call('get_action', { id: 'wf' }),
      await h.call('list_credentials'),
      await h.call('get_activity'),
      await h.call('get_recording_status'),
      await h.call('test_action', { tool: 'look_up_customer' }),
    ];
    for (const answer of answers) for (const pattern of forbidden()) expect(answer.text).not.toMatch(pattern);
    // The token and the folders of the machine never come back either
    for (const answer of answers) {
      expect(answer.text).not.toContain(h.studio.agentToken);
      expect(answer.text).not.toContain(h.workspace);
      expect(answer.text).not.toContain(h.dataDir);
    }
  });

  it('answers a Studio error with the redacted `error` text of the Studio and nothing else', async () => {
    h.studio.set('GET /api/secrets', { status: 503, body: { error: `The vault is locked for ${SECRET}.` } });
    const result = await h.call('list_credentials');
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('studio_error');
    expect(result.json.message).toBe('The vault is locked for ***.');
  });

  it('answers a plain error when the Studio is not reachable, with no address or token', async () => {
    await h.studio.close();
    const result = await h.call('list_actions');
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('studio_unavailable');
    expect(result.text).toContain('Show log');
    for (const pattern of forbidden()) expect(result.text).not.toMatch(pattern);
    expect(result.text).not.toContain(h.studio.agentToken);
    h.studio = await startFakeStudio(); // lets afterEach close a live one
  });

  it('cuts a long answer and keeps it valid JSON', async () => {
    h.studio.set('GET /api/activity', { status: 200, body: { entries: Array.from({ length: 100 }, (_, i) => ({ tool: 't', outcome: 'x'.repeat(400), i })) } });
    const result = await h.call('get_activity', { limit: 100 });
    expect(result.text.length).toBeLessThanOrEqual(20_000);
    expect(result.json.truncated).toBe(true);
    expect(typeof result.json.text).toBe('string');
  });

  it('gives only names and flags for credentials, and an instruction when one is missing', async () => {
    const result = await h.call('list_credentials');
    expect(result.isError).toBe(false);
    expect(result.json.credentials).toEqual([
      { name: 'CUSTOMERS_PASSWORD', kind: 'password', configured: false },
      { name: 'API_TOKEN', kind: 'token', configured: true },
    ]);
    expect(String(result.json.instruction)).toMatch(/Credentials screen/);
  });
});

describe('Studio_MCP changes only after a human said yes', () => {
  let h: Harness;
  beforeEach(async () => (h = await harness()));
  afterEach(async () => h.close());

  it('runs a read tool with no confirmation and no question', async () => {
    const result = await h.call('test_action', { tool: 'look_up_customer', arguments: { customer: 'Ada' } });
    expect(result.isError).toBe(false);
    expect(result.json.success).toBe(true);
    expect(h.asked).toEqual([]);
    expect(JSON.stringify(result.json)).not.toContain('screenshot');
    const sent = h.studio.requests.find((r) => r.path === '/api/playground/call');
    expect((sent?.body as Record<string, unknown>).confirm).toBeUndefined();
  });

  it('answers confirmation_required for a write tool without confirm, and runs nothing', async () => {
    const result = await h.call('test_action', { tool: 'add_customer', arguments: { name: 'Ada' } });
    expect(result.isError).toBe(true);
    expect(result.json.error).toBe('confirmation_required');
    expect(result.json.risk).toBe('write');
    expect(Array.isArray(result.json.writeSteps)).toBe(true);
    expect(h.studio.count('POST /api/playground/call')).toBe(0);
    expect(h.asked).toEqual([]);
  });

  it('asks the user first, then sends the call with confirm: true', async () => {
    const result = await h.call('test_action', { tool: 'add_customer', arguments: { name: 'Ada' }, confirm: true });
    expect(result.isError).toBe(false);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ source: 'studio-mcp', kind: 'test-action', tool: 'add_customer', risk: 'write' });
    const sent = h.studio.requests.find((r) => r.path === '/api/playground/call');
    expect((sent?.body as Record<string, unknown>).confirm).toBe(true);
  });

  for (const [decision, code] of [['denied', 'approval_denied'], ['timeout', 'approval_timeout'], ['unavailable', 'approval_unavailable']] as const) {
    it(`a ${decision} question runs nothing and answers ${code}`, async () => {
      h.decision.value = decision;
      const calls = [
        await h.call('test_action', { tool: 'add_customer', confirm: true }),
        await h.call('delete_action', { id: 'wf-read', confirm: true }),
      ];
      const preview = await h.call('preview_kiro_install', { scope: 'project' });
      calls.push(await h.call('install_to_kiro', { scope: 'project', confirmationId: String(preview.json.confirmationId) }));
      for (const result of calls) {
        expect(result.isError).toBe(true);
        expect(result.json.error).toBe(code);
      }
      expect(h.studio.count('POST /api/playground/call')).toBe(0);
      expect(h.studio.count('POST /api/workflows/delete')).toBe(0);
      expect(h.studio.count('POST /api/power/install')).toBe(0);
    });
  }

  it('refuses a credential passed as an argument without a request to the Playground', async () => {
    const result = await h.call('test_action', { tool: 'add_customer', arguments: { password: 'whatever' }, confirm: true });
    expect(result.isError).toBe(true);
    expect(result.json.field).toBe('arguments.password');
    expect(h.asked).toEqual([]);
    expect(h.studio.count('POST /api/playground/call')).toBe(0);
  });

  it('never puts a typed secret into the approval', async () => {
    h.studio.set('GET /api/playground', {
      status: 200,
      body: { available: true, tools: [{ name: 'add_customer', risk: 'write', writeSteps: [], sensitiveArgs: [] }] },
    });
    await h.call('test_action', { tool: 'add_customer', arguments: { api_key: SECRET, note: `has ${SECRET}` }, confirm: true });
    expect(JSON.stringify(h.asked)).not.toContain(SECRET);
  });

  it('delete_action needs confirm, then the approval, then deletes', async () => {
    const without = await h.call('delete_action', { id: 'wf-read' });
    expect(without.json.error).toBe('confirmation_required');
    expect(h.studio.count('POST /api/workflows/delete')).toBe(0);
    const done = await h.call('delete_action', { id: 'wf-read', confirm: true });
    expect(done.json).toEqual({ deleted: true, remaining: 1 });
    expect(h.asked[0]).toMatchObject({ kind: 'delete-action', risk: 'delete', summary: 'Delete the action Look up a customer' });
    expect(h.studio.requests.find((r) => r.path === '/api/workflows/delete')?.body).toEqual({ id: 'wf-read' });
  });

  it('delete_action answers unknown_action with the known ids', async () => {
    const result = await h.call('delete_action', { id: 'nope', confirm: true });
    expect(result.json.error).toBe('unknown_action');
    expect(result.json.knownIds).toEqual(['wf-read', 'wf-write']);
  });

  it('update_action needs confirm: true and sends no confirm field', async () => {
    const without = await h.call('update_action', { id: 'wf-read', label: 'New name' });
    expect(without.json.error).toBe('confirmation_required');
    expect(h.studio.count('POST /api/workflows/update')).toBe(0);
    const done = await h.call('update_action', { id: 'wf-read', label: 'New name', confirm: true });
    expect(done.isError).toBe(false);
    expect(done.json.id).toBe('wf-read');
    expect(h.studio.requests.find((r) => r.path === '/api/workflows/update')?.body).toEqual({ id: 'wf-read', label: 'New name' });
    expect(h.asked).toEqual([]);
  });

  it('install_to_kiro needs a preview, asks, then installs with the folder the preview named', async () => {
    const unknown = await h.call('install_to_kiro', { scope: 'project', confirmationId: 'guess' });
    expect(unknown.json.error).toBe('invalid_argument');
    const preview = await h.call('preview_kiro_install', { scope: 'project' });
    expect(preview.json).toMatchObject({ application: 'customers', scope: 'project', missingCredentials: ['CUSTOMERS_PASSWORD'], askBeforeChanges: true, confirmationId: 'confirm-1' });
    expect(preview.text).not.toContain('kiroPath');
    expect((h.studio.requests.find((r) => r.path === '/api/power/preview')?.body as Record<string, unknown>).workspacePath).toBe(h.workspace);
    const done = await h.call('install_to_kiro', { scope: 'project', confirmationId: 'confirm-1' });
    expect(done.json).toMatchObject({ installed: true, scope: 'project', missingCredentials: ['CUSTOMERS_PASSWORD'] });
    expect(h.asked[0]).toMatchObject({ kind: 'install', summary: 'Add customers to Kiro for this project' });
    expect(h.studio.requests.find((r) => r.path === '/api/power/install')?.body).toEqual({ scope: 'project', confirmationId: 'confirm-1', kiroPath: 'C:\\fake\\project\\.kiro' });
    expect(done.text).not.toContain('fake\\\\project');
  });

  it('names the missing credential and gives the instruction, with no value', async () => {
    h.studio.set('POST /api/playground/call', {
      status: 200,
      body: { success: false, error: 'missing_secret', failure: { missingSecret: 'DAEMONIZE_SECRET_API_TOKEN', missing: ['DAEMONIZE_SECRET_API_TOKEN'] } },
    });
    const result = await h.call('test_action', { tool: 'look_up_customer' });
    expect(result.json).toMatchObject({ error: 'missing_secret', missing: ['API_TOKEN'] });
    expect(String(result.json.instruction)).toMatch(/Credentials screen/);
  });

  it('answers the validation errors of the Playground', async () => {
    h.studio.set('POST /api/playground/call', {
      status: 200,
      body: { ok: false, refused: 'validation', error: 'validation', message: 'The call was refused before reaching the server: /customer: must be string', errors: [{ instancePath: '/customer', message: 'must be string' }] },
    });
    const result = await h.call('test_action', { tool: 'look_up_customer', arguments: { customer: 1 } });
    expect(result.json.error).toBe('invalid_argument');
    expect(result.json.errors).toHaveLength(1);
  });
});

describe('Studio_MCP recording and compile', () => {
  let h: Harness;
  beforeEach(async () => (h = await harness()));
  afterEach(async () => h.close());

  it('starts and finishes a recording with plain sentences', async () => {
    const start = await h.call('start_recording', { name: 'Add customer', url: 'https://example.com/app', reuseSession: false });
    expect(start.json).toMatchObject({ state: 'recording' });
    expect(h.studio.requests.find((r) => r.path === '/api/record/start')?.body).toEqual({ name: 'Add customer', url: 'https://example.com/app', reuseSession: false });
    expect((await h.call('finish_recording')).json).toMatchObject({ state: 'saving' });
  });

  it('answers the sample-mode message of the Studio for the recording tools', async () => {
    const message = 'This is sample data. Start the Studio without --sample to use this.';
    h.studio.set('POST /api/record/start', { status: 409, body: { error: message } });
    h.studio.set('POST /api/record/stop', { status: 409, body: { error: message } });
    for (const [tool, args] of [['start_recording', { name: 'a', url: 'https://example.com' }], ['finish_recording', {}]] as const) {
      const result = await h.call(tool, args);
      expect(result.json).toMatchObject({ error: 'sample_mode', message });
    }
  });

  it('carries the field and message of a refused recording', async () => {
    h.studio.set('POST /api/record/start', { status: 400, body: { error: 'Use a web address that starts with http or https.', field: 'url' } });
    const result = await h.call('start_recording', { name: 'a', url: 'ftp://x' });
    expect(result.json).toMatchObject({ error: 'studio_error', message: 'Use a web address that starts with http or https.', field: 'url' });
  });

  it('shows the recording state without a file path', async () => {
    h.studio.set('GET /api/record/status', { status: 200, body: { state: 'error', steps: 2, labels: ['a'], error: 'The recording stopped.', recoveryFile: 'C:\\secret\\place.json' } });
    const result = await h.call('get_recording_status');
    expect(result.json).toMatchObject({ state: 'error', message: 'The recording stopped.', steps: 2 });
    expect(result.text).not.toContain('place.json');
  });

  it('compile waits until the Studio leaves running', async () => {
    let polls = 0;
    h.studio.set('GET /api/compile/status', () => ({ status: 200, body: ++polls < 3 ? { state: 'running', phase: 'generating' } : { state: 'done', phase: null } }));
    const result = await h.call('compile', { http: 'auto' });
    expect(result.json).toMatchObject({ state: 'done' });
    expect(polls).toBe(3);
    expect(h.studio.requests.find((r) => r.path === '/api/compile')?.body).toEqual({ http: 'auto' });
  });

  it('compile answers the plain message of a busy Studio', async () => {
    h.studio.set('POST /api/compile', { status: 409, body: { error: 'A build is already running.' } });
    const result = await h.call('compile');
    expect(result.json).toMatchObject({ error: 'studio_error', message: 'A build is already running.' });
  });

  it('get_activity sends the limit and answers entries in the order of the Studio', async () => {
    h.studio.set('GET /api/activity', { status: 200, body: { entries: [{ tool: 'b' }, { tool: 'a' }], tools: ['a', 'b'], total: 2 } });
    const result = await h.call('get_activity', { limit: 5 });
    expect(result.json).toEqual({ entries: [{ tool: 'b' }, { tool: 'a' }] });
    expect(h.studio.requests[h.studio.requests.length - 1]?.query).toBe('?limit=5');
  });
});

describe('Studio_MCP in the home folder', () => {
  it('refuses the tools that write and sends nothing', async () => {
    const h = await harness({ homeIsWorkspace: true });
    try {
      for (const [tool, args] of [['start_recording', { name: 'a', url: 'https://example.com' }], ['compile', {}], ['delete_action', { id: 'x', confirm: true }]] as const) {
        const result = await h.call(tool, args);
        expect(result.json).toMatchObject({ error: 'invalid_argument', message: 'Open the folder of your project in Kiro first.' });
      }
      expect(h.studio.count()).toBe(0);
      // A tool that only reads still works
      expect((await h.call('list_actions')).isError).toBe(false);
    } finally {
      await h.close();
    }
  });
});
