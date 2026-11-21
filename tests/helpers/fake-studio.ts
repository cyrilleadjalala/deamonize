/**
 * A fake Studio for the Studio_MCP tests: an `http` server on loopback that answers the documented routes from fixtures
 * and records every request, so a test can assert zero requests. It checks the agent token and the agent route list
 * like the real Studio does. Fixtures hold only fictitious data.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { agentMayCall, AGENT_REFUSED } from '../../src/studio/agent-access.js';
import { writeLease, workspaceKey } from '../../src/studio/lease.js';
import { StudioConnection, type StudioApi } from '../../src/studio/mcp/connection.js';
import { createStudioMcpServer } from '../../src/studio/mcp/server.js';
import type { ApprovalOutcome, RequestApprovalOptions } from '../../src/replay/runtime/approval-queue.js';

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: unknown;
  /** The `x-studio-token` header as received. */
  header: string | undefined;
}
export interface FakeAnswer {
  status: number;
  body: unknown;
}
export type FakeHandler = FakeAnswer | ((request: RecordedRequest) => FakeAnswer | Promise<FakeAnswer>);

export interface FakeStudio {
  origin: string;
  port: number;
  agentToken: string;
  requests: RecordedRequest[];
  /** Replace the answer of `METHOD /path`, e.g. `studio.set('GET /api/secrets', { status: 200, body: {...} })`. */
  set(route: string, handler: FakeHandler): void;
  /** Requests received for `METHOD /path` (or all when omitted). */
  count(route?: string): number;
  reset(): void;
  close(): Promise<void>;
}

const FIXTURE_WORKFLOWS = {
  workflows: [
    {
      id: 'wf-read',
      label: 'Look up a customer',
      toolName: 'look_up_customer',
      description: 'Finds one customer by name.',
      risk: { read: 3, write: 0, delete: 0, highest: 'read' },
      variables: [{ name: 'customer', type: 'string', optional: false }],
      writeSteps: [],
      steps: [{ index: 0, action: 'click', label: 'Open the list' }, { index: 1, action: 'type', label: 'Type the name' }],
    },
    {
      id: 'wf-write',
      label: 'Add a customer',
      toolName: 'add_customer',
      risk: { read: 1, write: 2, delete: 0, highest: 'write' },
      variables: [{ name: 'name', type: 'string', optional: false }],
      writeSteps: [{ index: 2, label: 'Press Save', risk: 'write', kind: 'action' }],
      steps: [{ index: 0, action: 'type', label: 'Type the name' }, { index: 1, action: 'click', label: 'Open the form' }, { index: 2, action: 'click', label: 'Press Save' }],
    },
  ],
  truncated: false,
};

function fixtures(): Record<string, FakeAnswer> {
  return {
    'GET /api/health': { status: 200, body: { ok: true, sample: false } },
    'GET /api/overview': { status: 200, body: { sample: false, targetName: 'Customers', outputCompiled: true, workflowFileExists: true, recordingActive: false, targets: [] } },
    'GET /api/workflows': { status: 200, body: FIXTURE_WORKFLOWS },
    'GET /api/secrets': { status: 200, body: { secrets: [{ name: 'CUSTOMERS_PASSWORD', kind: 'password', configured: false }, { name: 'API_TOKEN', kind: 'token', configured: true }] } },
    'GET /api/activity': { status: 200, body: { entries: [], tools: [], total: 0 } },
    'GET /api/record/status': { status: 200, body: { state: 'idle', steps: 0, labels: [] } },
    'POST /api/record/start': { status: 202, body: { state: 'recording' } },
    'POST /api/record/stop': { status: 202, body: { state: 'saving' } },
    'POST /api/compile': { status: 202, body: { state: 'running' } },
    'GET /api/compile/status': { status: 200, body: { state: 'done', phase: null } },
    'POST /api/workflows/update': { status: 200, body: { workflow: { ...FIXTURE_WORKFLOWS.workflows[0], label: 'Look up a customer' }, recompile: 'started' } },
    'POST /api/workflows/delete': { status: 200, body: { ok: true, remaining: 1, recompile: 'started' } },
    'GET /api/playground': {
      status: 200,
      body: {
        available: true,
        tools: [
          { name: 'look_up_customer', risk: 'read', writeSteps: [], sensitiveArgs: [], label: 'Look up a customer' },
          { name: 'add_customer', risk: 'write', writeSteps: [{ index: 2, label: 'Press Save', risk: 'write', kind: 'action' }], sensitiveArgs: ['password'], label: 'Add a customer' },
        ],
      },
    },
    'POST /api/playground/call': { status: 200, body: { ok: true, tool: 'look_up_customer', elapsedMs: 12, success: true, text: 'Found 1 customer.', data: { customers: 1 }, levels: ['http'], screenshotUrl: '/api/playground/shot/aaaaaaaaaaaaaaaaaaaaaaaa.png' } },
    'GET /api/power/info': { status: 200, body: { available: true, installs: [] } },
    'POST /api/power/preview': {
      status: 200,
      body: { confirmationId: 'confirm-1', scope: 'project', kiroPath: 'C:\\fake\\project\\.kiro', files: [], replacesEntry: false, serverName: 'customers', placeholders: [], missingSecrets: ['CUSTOMERS_PASSWORD'], requiredSecrets: ['CUSTOMERS_PASSWORD'], backup: false, askBeforeChanges: true },
    },
    'POST /api/power/install': { status: 200, body: { written: [], placeholders: [], missingSecrets: ['CUSTOMERS_PASSWORD'], requiredSecrets: ['CUSTOMERS_PASSWORD'], scope: 'project' } },
  };
}

export interface FakeStudioOptions {
  agentToken?: string;
  fixtures?: Record<string, FakeHandler>;
}

export async function startFakeStudio(options: FakeStudioOptions = {}): Promise<FakeStudio> {
  const agentToken = options.agentToken ?? 'fake-agent-token-0123456789';
  const handlers = new Map<string, FakeHandler>(Object.entries({ ...fixtures(), ...(options.fixtures ?? {}) }));
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: unknown;
        try {
          body = raw === '' ? undefined : JSON.parse(raw);
        } catch {
          body = raw;
        }
        const header = req.headers['x-studio-token'];
        const record: RecordedRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.search, body, header: Array.isArray(header) ? header[0] : header };
        requests.push(record);
        const send = (status: number, payload: unknown): void => {
          const text = JSON.stringify(payload);
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
          res.end(text);
        };
        if (record.header !== agentToken) return send(401, { error: 'missing or invalid token' });
        if (!agentMayCall(record.method, record.path)) return send(403, { error: AGENT_REFUSED });
        const handler = handlers.get(`${record.method} ${record.path}`);
        if (handler === undefined) return send(404, { error: 'not found' });
        const answer = typeof handler === 'function' ? await handler(record) : handler;
        send(answer.status, answer.body);
      })();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    agentToken,
    requests,
    set: (route, handler) => void handlers.set(route, handler),
    count: (route) => (route === undefined ? requests.length : requests.filter((r) => `${r.method} ${r.path}` === route).length),
    reset: () => void (requests.length = 0),
    close: () => new Promise<void>((done) => (server.closeAllConnections?.(), server.close(() => done()))),
  };
}

export interface McpHarness {
  studio: FakeStudio;
  workspace: string;
  dataDir: string;
  client: Client;
  /** The approvals that the Studio_MCP asked for. */
  asked: RequestApprovalOptions[];
  /** Every request the Studio_MCP tried, in order, mixed with `{ ask }` markers: the order of events. */
  events: string[];
  decision: { value: ApprovalOutcome['decision'] };
  env: NodeJS.ProcessEnv;
  call(name: string, args?: unknown): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** A Studio_MCP wired to a fake Studio through a real lease, with an in-memory MCP client and a scripted approver. */
export async function startMcpHarness(options: { homeIsWorkspace?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<McpHarness> {
  const root = mkdtempSync(join(tmpdir(), 'dz-mcp-'));
  const workspace = join(root, 'project');
  const dataDir = join(root, 'data');
  mkdirSync(workspace);
  mkdirSync(dataDir);
  const studio = await startFakeStudio();
  await leaseFor(dataDir, workspace, studio);
  const env: NodeJS.ProcessEnv = options.env ?? {};
  const inner = new StudioConnection({ workspace, dataDir, env });
  const events: string[] = [];
  const api: StudioApi = {
    request: (method, path, body, opts) => {
      events.push(`${method} ${path.split('?')[0]}`);
      return inner.request(method, path, body, opts);
    },
    secretValues: () => inner.secretValues(),
    close: () => inner.close(),
  };
  const asked: RequestApprovalOptions[] = [];
  const decision: { value: ApprovalOutcome['decision'] } = { value: 'approved' };
  const server = createStudioMcpServer({
    api,
    workspace,
    env,
    requestApproval: async (o) => {
      events.push('ASK');
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
    events,
    decision,
    env,
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args as Record<string, unknown> | undefined })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      const text = result.content.map((c) => c.text).join('');
      return { isError: result.isError === true, text, json: JSON.parse(text) as Record<string, unknown> };
    },
    async close() {
      await client.close();
      await inner.close();
      await studio.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Writes a lease that points at the fake Studio (this test process is the "live" pid), so a Studio_MCP attaches to it. */
export async function leaseFor(dataDir: string, workspace: string, studio: FakeStudio): Promise<void> {
  await writeLease(dataDir, {
    v: 1,
    origin: studio.origin,
    agentToken: studio.agentToken,
    pid: process.pid,
    workspace: workspaceKey(workspace),
    startedAt: new Date().toISOString(),
  });
}
