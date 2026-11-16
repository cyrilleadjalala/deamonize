/**
 * Level 1 end to end (requirements 12.1, 13.3, 13.4, 13.6): a single-page application with a JSON API that needs a
 * session cookie and a bearer token. The workflows are recorded in a real browser, compiled with `--http` and called
 * over MCP. A workflow whose steps all have a request runs without any browser; a failed read request is repeated on the
 * page; a failed write request is never repeated.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compile } from '../../src/cli/commands/compile.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';
import { scanForValues } from '../helpers/scan-artifacts.js';
import { BEARER, COOKIE_VALUE, recordCustomerWorkflows, sessionStorageState, startCustomersApp, type CustomersApp } from '../helpers/customers-app.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

type Result = Record<string, any>;

describe('Level 1: direct HTTP replay (record, compile --http, call over MCP)', () => {
  let app: CustomersApp;
  let browser: Browser;
  let work: string;
  let outputDir: string;
  let storageStatePath: string;
  let workflowFile: string;
  const dirs: string[] = [];
  const open: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const results: string[] = [];

  beforeAll(async () => {
    app = await startCustomersApp();
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    const workflows = await recordCustomerWorkflows(browser, app);
    app.reset();

    work = await mkdtemp(join(tmpdir(), 'daemonize-http-'));
    dirs.push(work);
    // The saved login lives outside the compiled output
    storageStatePath = join(work, 'state.json');
    await writeFile(storageStatePath, JSON.stringify(sessionStorageState(app.baseUrl)));
    workflowFile = join(work, 'workflows.json');
    const set: WorkflowSet = { version: '1', targetType: 'web', targetName: 'Customers app', startUrl: `${app.baseUrl}/`, workflows };
    await writeFile(workflowFile, serializeWorkflowSet(set));

    // Under the workspace so the generated server finds its dependencies in node_modules
    outputDir = await mkdtemp(join(workspaceRoot, '.http-'));
    dirs.push(outputDir);
    const log = console.log;
    console.log = () => { };
    try {
      await compile(workflowFile, outputDir, { http: 'auto' });
    } finally {
      console.log = log;
    }
  });

  afterAll(async () => {
    for (const { client, transport } of open) await closeClient(client, transport);
    await browser?.close();
    await app?.close();
    for (const dir of dirs) await removeDir(dir);
  }, 60000);

  interface Server {
    call(tool: string, args?: Record<string, unknown>): Promise<Result>;
    listing: string;
  }

  /** `browser: false` makes Chromium unavailable to the server: a call that succeeds did not launch it. */
  async function connect(options: { browser: boolean; env?: Record<string, string>; storageState?: boolean }): Promise<Server> {
    const client = new Client({ name: 'http-replay-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outputDir, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: {
        DAEMONIZE_STEP_TIMEOUT_MS: '5000',
        DAEMONIZE_CHROMIUM_PATH: options.browser ? process.env.DAEMONIZE_CHROMIUM_PATH ?? '' : join(work, 'no-such-chromium.exe'),
        ...(options.storageState === false ? {} : { DAEMONIZE_STORAGE_STATE: storageStatePath }),
        ...(options.env ?? {}),
      },
    });
    await client.connect(transport);
    open.push({ client, transport });
    const listing = JSON.stringify((await client.listTools()).tools);
    return {
      listing,
      async call(tool, args = {}) {
        const response = await client.callTool({ name: tool, arguments: args });
        const text = (response.content as Array<{ text: string }>)[0].text;
        results.push(text);
        return JSON.parse(text);
      },
    };
  }

  const auth = { DAEMONIZE_SECRET_AUTHORIZATION: `Bearer ${BEARER}` };

  it('compiles the Level 1 runtime, lists the secret names and says which tools run over HTTP', () => {
    for (const file of ['http-replay.ts', 'http-replay.js', 'replay.js']) {
      expect(readFileSync(join(outputDir, file), 'utf8').length).toBeGreaterThan(0);
    }
    // Copied verbatim from src/replay/runtime
    expect(readFileSync(join(outputDir, 'http-replay.ts'), 'utf8')).toBe(readFileSync(join(workspaceRoot, 'src/replay/runtime/http-replay.ts'), 'utf8'));
    const mcp = JSON.parse(readFileSync(join(outputDir, 'mcp.json'), 'utf8'));
    const env = Object.values(mcp.mcpServers as Record<string, { env: Record<string, string> }>)[0].env;
    expect(env).toEqual({ DAEMONIZE_SECRET_AUTHORIZATION: '${DAEMONIZE_SECRET_AUTHORIZATION}' });
    const skill = readFileSync(join(outputDir, 'skills', Object.keys(mcp.mcpServers)[0], 'SKILL.md'), 'utf8');
    expect(skill).toContain('## HTTP replay');
    expect(skill).toContain('Runs over HTTP, without a browser.');
    expect(skill).toMatch(/Step 2 runs over HTTP; steps 3, 4 use the browser/);
    expect(readFileSync(join(outputDir, 'sandbox', 'Dockerfile'), 'utf8')).toContain('COPY http-replay.js ./http-replay.js');
  });

  it('(a) searches over HTTP with no browser: JSON data, drift judged on the shape, fast', async () => {
    const server = await connect({ browser: false, env: auth });
    expect(server.listing).toContain('Runs over HTTP, without a browser.');
    await server.call('find_customers', { query: 'Ada' });
    const before = { views: app.pageViews, direct: app.direct.search };
    const startedAt = Date.now();
    const result = await server.call('find_customers', { query: 'Ada' });
    const wall = Date.now() - startedAt;
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toEqual({ customers: [{ id: 1, name: 'Ada', email: 'ada@example.com' }], total: 1 });
    expect(result).toMatchObject({ screenType: 'dom', drifted: false, driftChecked: true, levels: ['http', 'http'] });
    expect(result.levelFallback).toBeUndefined();
    expect(typeof result.title).toBe('string');
    expect(result.text).toContain('Ada');
    // Chromium was unavailable and the page was never loaded
    expect(app.pageViews).toBe(before.views);
    expect(app.direct.search).toBe(before.direct + 1);
    expect(result.elapsedMs).toBeLessThan(500);
    expect(wall).toBeLessThan(500);
    // A value of the Payload that needs encoding reaches the API as typed
    const none = await server.call('find_customers', { query: 'Zoë & co' });
    expect(none.success).toBe(true);
    expect(none.data).toEqual({ customers: [], total: 0 });
    expect(none.drifted).toBe(false);
  });

  it('authenticates with DAEMONIZE_COOKIE_HEADER instead of a file', async () => {
    const server = await connect({ browser: false, storageState: false, env: { ...auth, DAEMONIZE_COOKIE_HEADER: `sid=${COOKIE_VALUE}` } });
    const result = await server.call('find_customers', { query: 'Bob' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data.customers.map((c: { name: string }) => c.name)).toEqual(['Bob']);

    // Neither a file nor a header: the API answers 401, a read step would go to the page, which cannot start here
    const anonymous = await (await connect({ browser: false, storageState: false, env: auth })).call('find_customers', { query: 'Bob' });
    expect(anonymous.success).toBe(false);
  });

  it('returns missing_secret naming the variable before any request', async () => {
    const server = await connect({ browser: false });
    const before = app.total.search;
    const result = await server.call('find_customers', { query: 'Ada' });
    expect(result).toMatchObject({ success: false, error: 'missing_secret', failure: { missingSecret: 'DAEMONIZE_SECRET_AUTHORIZATION' } });
    expect(app.total.search).toBe(before);
  });

  it('(b) creates a customer over HTTP; a forced 500 neither falls back nor runs twice', async () => {
    const server = await connect({ browser: false, env: auth });
    const views = app.pageViews;
    const created = await server.call('add_customer', { cname: 'Nia', cemail: 'nia@example.com' });
    expect(created.success, JSON.stringify(created)).toBe(true);
    expect(created.levels).toEqual(['http', 'http', 'http']);
    expect(created.data).toMatchObject({ name: 'Nia', email: 'nia@example.com' });
    expect(app.customers.map((c) => c.name)).toContain('Nia');
    expect(app.direct.create).toBe(1);

    app.failCreate = true;
    const count = app.customers.length;
    const hits = app.total.create;
    const failed = await server.call('add_customer', { cname: 'Oli', cemail: 'oli@example.com' });
    app.failCreate = false;
    expect(failed).toMatchObject({
      success: false,
      error: 'http_failed',
      drifted: true,
      failure: { stepIndex: 2, action: 'click', risk: 'write', level: 'http', status: 500 },
    });
    expect(failed.failure.reason).toMatch(/never retried/);
    // One request reached the server: no second attempt, no replay on the page
    expect(app.total.create).toBe(hits + 1);
    expect(app.customers).toHaveLength(count);
    expect(app.pageViews).toBe(views);
    expect(failed.levels).toEqual(['http', 'http', 'http']);
  });

  it('(c) repeats a read step on the page when its API changed, and flags levelFallback', async () => {
    const server = await connect({ browser: true, env: auth });
    app.changeApiForDirect = true;
    const views = app.pageViews;
    const direct = app.direct.search;
    let result: Result;
    try {
      result = await server.call('find_customers', { query: 'Ada' });
    } finally {
      app.changeApiForDirect = false;
    }
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.levelFallback).toBe(true);
    expect(result.levels).toEqual(['accessibility', 'accessibility']);
    expect(result.text).toContain('Ada');
    expect(result.text).not.toContain('Bob');
    // One direct attempt, then the page; the page's own requests come from a browser
    expect(app.direct.search).toBe(direct + 1);
    expect(app.pageViews).toBe(views + 1);
  });

  it('(d) keeps the server-rendered form on Level 2, and mixes levels per step', async () => {
    const server = await connect({ browser: true, env: auth });
    const direct = { ...app.direct };
    const ssr = await server.call('save_ssr_name', { ssr_name: 'Grace' });
    expect(ssr.success, JSON.stringify(ssr)).toBe(true);
    expect(ssr.text).toContain('Saved Grace');
    expect(ssr.levels).toEqual(['accessibility', 'accessibility']);
    expect(app.direct).toEqual(direct);

    // The search runs over HTTP; the field typed for it is replayed on the page once the form needs the browser
    const mixed = await server.call('find_then_save_ssr', { query: 'Ada', ssr_name: 'Linus' });
    expect(mixed.success, JSON.stringify(mixed)).toBe(true);
    expect(mixed.text).toContain('Saved Linus');
    expect(mixed.levels).toEqual(['accessibility', 'http', 'accessibility', 'accessibility']);
    expect(mixed.levelFallback).toBeUndefined();
    expect(app.direct.search).toBe(direct.search + 1);
  });

  it('(e) leaves no cookie or token in the artifacts, the workflow file or any result', async () => {
    const values = [COOKIE_VALUE, BEARER, `Bearer ${BEARER}`];
    expect(await scanForValues(outputDir, values)).toEqual([]);
    expect(await scanForValues(work, [BEARER, `Bearer ${BEARER}`])).toEqual([]);
    expect(readFileSync(workflowFile, 'utf8')).not.toContain(COOKIE_VALUE);
    expect(results.length).toBeGreaterThan(5);
    for (const text of results) {
      for (const value of values) expect(text).not.toContain(value);
    }
  });
});
