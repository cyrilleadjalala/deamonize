/**
 * Bug 2 (nextjs-spa-replay-fixes): a mixed workflow in `--http` mode. A two-screen login (password, then a code)
 * whose "Continue" click has a recipe `POST /api/login/credentials`. The server sets the cookie that the second
 * screen needs and the page renders the second screen itself. Run with Node fetch outside the browser, the page
 * would stay on the first screen. The plan must keep every step before the last ui step in the browser.
 *
 * Property 3 (bug condition): the browser screen advances before the code step runs.
 * Requirements 2.5, 2.7, 3.7: a write step still runs once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compile } from '../../src/cli/commands/compile.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { HttpRecipe, Workflow, WorkflowSet } from '../../src/types.js';
import { closeClient, removeDir } from '../helpers/cleanup.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');

const PAGE = `<!doctype html>
<html><head><title>Sign in</title></head>
<body>
<main id="screen">
  <h1>Sign in</h1>
  <label for="pw">Password</label><input id="pw" type="text" />
  <button id="go" type="button">Continue</button>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const post = async (path, body) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  function secondScreen() {
    $('screen').innerHTML =
      '<h1>Two-factor</h1><label for="code">Code</label><input id="code" type="text" /><button id="verify" type="button">Verify</button>';
    $('verify').onclick = async () => {
      const r = await post('/api/login/verify', { second_factor: $('code').value });
      $('screen').innerHTML = r.status === 200 ? '<h1>Welcome ' + r.json.user + '</h1>' : '<h1>Wrong code</h1>';
    };
  }
  $('go').onclick = async () => {
    const r = await post('/api/login/credentials', { first_factor: $('pw').value });
    if (r.status === 200) secondScreen(); else $('screen').innerHTML = '<h1>Wrong password</h1>';
  };
</script>
</body></html>`;

interface LoginApp {
  baseUrl: string;
  /** Requests by endpoint, whoever sent them, and those that did not come from a browser. */
  total: { credentials: number; verify: number };
  direct: { credentials: number; verify: number };
  close(): Promise<void>;
}

async function startLoginApp(): Promise<LoginApp> {
  const app: LoginApp = { baseUrl: '', total: { credentials: 0, verify: 0 }, direct: { credentials: 0, verify: 0 }, close: async () => undefined };
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>);
    const direct = !/Mozilla/.test(req.headers['user-agent'] ?? '');
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/login/credentials' && req.method === 'POST') {
      app.total.credentials += 1;
      if (direct) app.direct.credentials += 1;
      if (body.first_factor !== 'hunter2') return json(401, { error: 'bad password' });
      return json(200, { next: 'code' }, { 'set-cookie': 'stage=code; Path=/; HttpOnly' });
    }
    if (url.pathname === '/api/login/verify' && req.method === 'POST') {
      app.total.verify += 1;
      if (direct) app.direct.verify += 1;
      // The second step needs the cookie the first one set in the browser
      if (!(req.headers.cookie ?? '').includes('stage=code')) return json(401, { error: 'no session' });
      return body.second_factor === '123456' ? json(200, { ok: true, user: 'ada' }) : json(403, { error: 'bad code' });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  app.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return app;
}

function recipe(baseUrl: string, path: string, variable: string, auth: HttpRecipe['auth'], secret?: string): HttpRecipe {
  return {
    method: 'POST',
    url: `${baseUrl}${path}`,
    query: {},
    body: { [variable]: secret === undefined ? { $var: variable } : { $secret: secret } },
    bodyFormat: 'json',
    bindings: secret === undefined ? [{ variable, in: 'body', name: `/${variable}` }] : [],
    redacted: secret === undefined ? [] : [{ in: 'body', name: `/${variable}`, secret }],
    auth,
    expectStatus: 200,
  };
}

describe('--http on a mixed UI + HTTP workflow', () => {
  let app: LoginApp;
  let work: string;
  let outputDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let tool: string;

  beforeAll(async () => {
    app = await startLoginApp();
    work = await mkdtemp(join(tmpdir(), 'daemonize-mixed-'));
    const workflow: Workflow = {
      id: 'a1111111-1111-4111-8111-111111111111',
      label: 'Sign in with code',
      steps: [
        { actionType: 'type', selectors: ['role=textbox[name="Password"]', '#pw'], variable: 'first_factor', value: 'hunter2', anchor: { role: 'textbox', name: 'Password', frame: [] }, risk: 'read' },
        {
          actionType: 'click',
          selectors: ['role=button[name="Continue"]', '#go'],
          anchor: { role: 'button', name: 'Continue', frame: [] },
          risk: 'write',
          http: recipe(app.baseUrl, '/api/login/credentials', 'first_factor', 'none'),
        },
        { actionType: 'type', selectors: ['role=textbox[name="Code"]', '#code'], secretRef: 'CODE', anchor: { role: 'textbox', name: 'Code', frame: [] }, risk: 'read' },
        {
          actionType: 'click',
          selectors: ['role=button[name="Verify"]', '#verify'],
          anchor: { role: 'button', name: 'Verify', frame: [] },
          risk: 'write',
          http: recipe(app.baseUrl, '/api/login/verify', 'second_factor', 'storageState', 'CODE'),
        },
      ],
      variables: [{ name: 'first_factor' }],
      secrets: ['CODE'],
      observedPayloads: [],
    };
    const set: WorkflowSet = { version: '1', targetType: 'web', targetName: 'Login app', startUrl: `${app.baseUrl}/`, workflows: [workflow] };
    const file = join(work, 'workflows.json');
    await writeFile(file, serializeWorkflowSet(set));
    outputDir = await mkdtemp(join(workspaceRoot, '.http-'));
    const log = console.log;
    console.log = () => { };
    try {
      await compile(file, outputDir, { http: 'auto' });
    } finally {
      console.log = log;
    }
    client = new Client({ name: 'http-mixed-test', version: '1.0.0' });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(outputDir, 'mcp-server.js')],
      cwd: workspaceRoot,
      env: { DAEMONIZE_STEP_TIMEOUT_MS: '8000', DAEMONIZE_SECRET_CODE: '123456', DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH ?? '' },
    });
    await client.connect(transport);
    tool = (await client.listTools()).tools.map((t) => t.name).find((name) => name.startsWith('sign_in')) ?? 'sign_in_with_code';
  });

  afterAll(async () => {
    await closeClient(client, transport);
    await app?.close();
    await removeDir(work);
    await removeDir(outputDir);
  }, 60000);

  it('advances the browser to the code screen before the code step, and runs each write request once', async () => {
    const response = await client.callTool({ name: tool, arguments: { first_factor: 'hunter2' } });
    const result = JSON.parse((response.content as Array<{ text: string }>)[0].text) as Record<string, any>;
    expect(result.success, JSON.stringify(result)).toBe(true);
    // The browser itself reached the last screen
    expect(result.text).toContain('Welcome ada');
    // Every step ran in the browser: nothing went through Node fetch
    expect(result.levels).toEqual(['accessibility', 'accessibility', 'accessibility', 'accessibility']);
    expect(app.direct).toEqual({ credentials: 0, verify: 0 });
    // A write step runs once
    expect(app.total).toEqual({ credentials: 1, verify: 1 });
  });
});
