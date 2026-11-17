import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile } from '../../src/cli/commands/compile.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { rawRequest, type RawResponse } from '../helpers/http.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');
const PLANTED = 'PlantedSecret-4c1d9e7b';
const chromiumEnv: Record<string, string> = process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {};

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

async function compileSet(prefix: string, set: WorkflowSet): Promise<{ dir: string; out: string; file: string }> {
  // Under the workspace so the generated server finds its dependencies in node_modules
  const dir = await mkdtemp(join(workspaceRoot, prefix));
  const file = join(dir, 'workflows.json');
  await writeFile(file, serializeWorkflowSet(set));
  const out = join(dir, 'out');
  const log = console.log;
  console.log = () => { };
  try {
    await compile(file, out);
  } finally {
    console.log = log;
  }
  return { dir, out, file };
}

interface Api {
  (method: string, path: string, options?: { body?: unknown; raw?: string; headers?: Record<string, string>; token?: boolean }): Promise<RawResponse>;
  json(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }>;
}

function apiFor(handle: StudioHandle): Api {
  const call = (async (method, path, options = {}) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${handle.port}`, ...(options.headers ?? {}) };
    if (options.token !== false) headers['x-studio-token'] = handle.token;
    let body: string | undefined;
    if (options.raw !== undefined) body = options.raw;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] ??= 'application/json';
    }
    return rawRequest(handle, method, path, headers, body);
  }) as Api;
  call.json = async (method, path, body) => {
    const res = await call(method, path, { body });
    let parsed: any;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, text: res.text };
  };
  return call;
}

const shotDirs = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('daemonize-studio-shots-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('Studio playground, terminal server', () => {
  let dir: string;
  let handle: StudioHandle;
  let api: Api;
  const seen: string[] = [];
  const track = <T extends { text: string }>(res: T): T => {
    seen.push(res.text);
    return res;
  };

  beforeAll(async () => {
    const built = await compileSet('.pg-tui-', terminalSet);
    dir = built.dir;
    handle = await startStudio({ workflowFile: built.file, outDir: built.out, env: { DAEMONIZE_SECRET_X: PLANTED }, playgroundIdleMs: 60_000 });
    api = apiFor(handle);
  }, 180000);

  afterAll(async () => {
    await handle?.close();
    if (dir) await removeDir(dir);
  });

  it('lists the tools of the generated server with their schema, risk and levels', async () => {
    const res = track(await api.json('GET', '/api/playground'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, simulated: false, mode: 'strict', healSupport: false, serverStarted: true });
    const tools = res.body.tools as Array<any>;
    expect(tools.map((t) => t.name).sort()).toEqual(['greet_and_save', 'greet_someone']);
    const greet = tools.find((t) => t.name === 'greet_someone');
    expect(greet.risk).toBe('read');
    expect(greet.inputSchema.properties).toHaveProperty('your_name');
    expect(greet.inputSchema.properties).not.toHaveProperty('_timeoutMs');
    expect(greet.inputSchema.$schema).toBeUndefined();
    expect(tools.find((t) => t.name === 'greet_and_save').risk).toBe('write');
    // The secrets and write steps of each workflow travel with the tool (names and statuses only)
    expect(greet).toMatchObject({ secrets: [], unusedSecrets: [], secretsBasis: 'ui-only', writeSteps: [], writeSummary: 'none' });
    const save = tools.find((t) => t.name === 'greet_and_save');
    expect(save.writeSummary).toBe('actions');
    expect(save.writeSteps).toHaveLength(1);
    expect(save.writeSteps[0]).toMatchObject({ risk: 'write', kind: 'action' });  });

  it('calls a tool with valid arguments and returns the summary a caller needs', async () => {
    const res = track(await api.json('POST', '/api/playground/call', { tool: 'greet_someone', arguments: { your_name: 'Ada' } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tool: 'greet_someone', success: true, screenType: 'terminal', drifted: false });
    expect(res.body.text).toContain('Hello Ada!');
    expect(typeof res.body.elapsedMs).toBe('number');
    expect(res.body.failure).toBeUndefined();
  });

  it('refuses invalid arguments before the server is asked, with the validation message', async () => {
    const before = (await api.json('GET', '/api/playground/history')).body.history.length;
    const res = track(await api.json('POST', '/api/playground/call', { tool: 'greet_someone', arguments: { your_name: 5 } }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, refused: 'validation', error: 'validation', success: false, elapsedMs: 0 });
    expect(res.body.message).toMatch(/refused before reaching the server/);
    expect(res.body.errors[0].message).toMatch(/string/);
    const history = (await api.json('GET', '/api/playground/history')).body.history;
    expect(history).toHaveLength(before + 1);
    expect(history[history.length - 1]).toMatchObject({ tool: 'greet_someone', ok: false, error: 'validation' });
    const missing = track(await api.json('POST', '/api/playground/call', { tool: 'greet_someone', arguments: {} }));
    expect(missing.body.refused).toBe('validation');
  });

  it('needs an explicit confirm to run a write tool, and answers 404 for an unknown tool', async () => {
    const denied = track(await api.json('POST', '/api/playground/call', { tool: 'greet_and_save', arguments: { your_name: 'Bob' } }));
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ error: 'confirmation_required', risk: 'write' });
    const ok = track(await api.json('POST', '/api/playground/call', { tool: 'greet_and_save', arguments: { your_name: 'Bob' }, confirm: true }));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ success: true });
    expect(ok.body.text).toContain('Hello Bob!');
    expect((await api.json('POST', '/api/playground/call', { tool: 'nope', arguments: {}, confirm: true })).status).toBe(404);
  });

  it('checks the shape of a call request', async () => {
    const post = (body: unknown) => api.json('POST', '/api/playground/call', body);
    expect((await post({})).status).toBe(400);
    expect((await post({ tool: 'greet_someone', arguments: [] })).status).toBe(400);
    expect((await post({ tool: 'greet_someone', extra: 1 })).status).toBe(400);
    expect((await post({ tool: 'greet_someone', timeoutMs: 0 })).status).toBe(400);
    expect((await post({ tool: 'greet_someone', timeoutMs: 600001 })).status).toBe(400);
    expect((await post({ tool: 'greet_someone', mode: 'turbo' })).status).toBe(400);
    expect((await post({ tool: 'greet_someone', confirm: 'yes' })).status).toBe(400);
    const heal = await post({ tool: 'greet_someone', arguments: { your_name: 'A' }, mode: 'heal' });
    expect(heal.status).toBe(400);
    expect(heal.body.error).toBe('mode_unsupported');
    expect((await api.json('POST', '/api/playground/restart', { mode: 'heal' })).status).toBe(400);
  });

  it('is protected like the other POSTs: token, request header, origin, host, content type, size', async () => {
    const body = { tool: 'greet_someone', arguments: { your_name: 'Ada' } };
    // No token at all
    expect((await api('GET', '/api/playground', { token: false })).status).toBe(401);
    expect((await api('POST', '/api/playground/call', { body, token: false })).status).toBe(401);
    expect((await api('GET', '/api/playground/history', { token: false })).status).toBe(401);
    expect((await api('GET', `/api/playground/shot/${'a'.repeat(24)}.png`, { token: false })).status).toBe(401);
    // The cookie of the first visit
    const visit = await rawRequest(handle, 'GET', `/?token=${handle.token}`, { host: `127.0.0.1:${handle.port}` });
    const cookie = String((visit.headers['set-cookie'] as string[])[0]).split(';')[0];
    const origin = `http://127.0.0.1:${handle.port}`;
    const viaCookie = (headers: Record<string, string>) => api('POST', '/api/playground/call', { body, token: false, headers: { cookie, ...headers } });
    expect((await viaCookie({})).status).toBe(401);
    expect((await viaCookie({ 'x-studio-request': '1' })).status).toBe(401);
    expect((await viaCookie({ 'x-studio-request': '1', origin: 'http://evil.example' })).status).toBe(403);
    expect((await viaCookie({ 'x-studio-request': '1', origin })).status).toBe(200);
    // Host check (DNS rebinding) and content type
    expect((await api('POST', '/api/playground/call', { body, headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await api('POST', '/api/playground/call', { raw: JSON.stringify(body), headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await api('POST', '/api/playground/call', { raw: '{not json', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await api('POST', '/api/playground/call', { raw: '[1]', headers: { 'content-type': 'application/json' } })).status).toBe(400);
    expect((await api('POST', '/api/playground/call', { headers: { 'content-type': 'application/json', 'content-length': '70000' } })).status).toBe(413);
    // Methods
    expect((await api('GET', '/api/playground/call')).status).toBe(405);
    expect((await api('POST', '/api/playground')).status).toBe(405);
    expect((await api('POST', '/api/playground/history')).status).toBe(405);
    expect((await api('GET', '/api/playground/nothing')).status).toBe(404);
    // No CORS header, ever
    const res = await api('GET', '/api/playground');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves pictures only for ids it issued', async () => {
    for (const bad of ['../../etc/passwd.png', '%2e%2e%2fx.png', 'abc.png', `${'A'.repeat(24)}.png`, `${'a'.repeat(24)}.png`, `${'a'.repeat(24)}.gif`, '.png']) {
      const res = await api('GET', `/api/playground/shot/${bad}`);
      expect([404, 403, 400], bad).toContain(res.status);
    }
    expect((await api('POST', `/api/playground/shot/${'a'.repeat(24)}.png`)).status).toBe(405);
  });

  it('stops and restarts the server on request, and starts it again on the next call', async () => {
    const stopped = await api.json('POST', '/api/playground/stop');
    expect(stopped.body).toMatchObject({ ok: true, serverStarted: false });
    expect((await api.json('GET', '/api/playground/history')).body.serverStarted).toBe(false);
    const restarted = await api.json('POST', '/api/playground/restart', {});
    expect(restarted.body).toMatchObject({ ok: true, serverStarted: true, mode: 'strict' });
    await api.json('POST', '/api/playground/stop');
    const call = await api.json('POST', '/api/playground/call', { tool: 'greet_someone', arguments: { your_name: 'Again' } });
    expect(call.body).toMatchObject({ success: true });
    expect((await api.json('GET', '/api/playground/history')).body.serverStarted).toBe(true);
  });

  it('never returns the secrets of the environment, in any answer or in the history', async () => {
    const echo = track(await api.json('POST', '/api/playground/call', { tool: 'greet_someone', arguments: { your_name: PLANTED } }));
    expect(echo.body.success).toBe(true);
    expect(echo.body.text).toContain('Hello ***!');
    track(await api.json('GET', '/api/playground'));
    track(await api.json('GET', '/api/playground/history'));
    expect(seen.length).toBeGreaterThan(8);
    for (const text of seen) expect(text).not.toContain(PLANTED);
  });
});

describe('Studio playground, web server', () => {
  let dir: string;
  let handle: StudioHandle;
  let api: Api;
  let site: Server;
  let keptId = '';

  const LOGIN_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body><label for="pw">Password</label><input id="pw" type="password"></body></html>';

  beforeAll(async () => {
    site = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      res.setHeader('content-type', 'text/html');
      if (path === '/result') res.end('<!doctype html><html><head><title>Result</title></head><body><p id="msg">Redesigned result page</p></body></html>');
      else if (path === '/login') res.end(LOGIN_PAGE);
      else res.end('<!doctype html><html><head><title>Home</title></head><body><a id="go" href="/result">Go</a> <a id="signin" href="/login">Sign in</a></body></html>');
    });
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
    const startUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    const wf = (id: string, label: string, selector: string, extra: Partial<Workflow> = {}): Workflow => ({
      id, label, steps: [{ actionType: 'click', selectors: [selector] }], variables: [], observedPayloads: [], ...extra,
    });
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'Playground Page',
      startUrl,
      workflows: [
        // The recorded final screen is not the page the link leads to now: success with drifted: true
        wf('a1111111-1111-4111-8111-111111111111', 'Open result', '#go', { finalScreenId: '0123456789abcdef' as Workflow['finalScreenId'] }),
        // No locator matches: a strict failure with a screenshot of the page
        wf('a2222222-2222-4222-8222-222222222222', 'Open missing', '#missing'),
        wf('a3333333-3333-4333-8333-333333333333', 'Open login', '#signin'),
      ],
    };
    const built = await compileSet('.pg-web-', set);
    dir = built.dir;
    handle = await startStudio({ workflowFile: built.file, outDir: built.out, env: { ...chromiumEnv, DAEMONIZE_STEP_TIMEOUT_MS: '1500', DAEMONIZE_SECRET_X: PLANTED } });
    api = apiFor(handle);
  }, 180000);

  afterAll(async () => {
    await handle?.close();
    await new Promise<void>((done) => site?.close(() => done()));
    if (dir) await removeDir(dir);
  });

  it('shows drifted: true on a call that succeeded on a changed page', async () => {
    const res = await api.json('POST', '/api/playground/call', { tool: 'open_result', arguments: {} });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, success: true, drifted: true, driftChecked: true, mode: 'strict', title: 'Result' });
    expect(res.body.text).toContain('Redesigned result page');
    expect(res.body.screenshotUrl).toBeUndefined();
  });

  it('reports a strict failure with the diagnostics and a screenshot served from the Studio', async () => {
    const res = await api.json('POST', '/api/playground/call', { tool: 'open_missing', arguments: {} });
    expect(res.body).toMatchObject({ ok: true, success: false, drifted: true, mode: 'strict', error: 'step_failed' });
    expect(res.body.failure).toMatchObject({ stepIndex: 0, action: 'click' });
    expect(Array.isArray(res.body.failure.tried)).toBe(true);
    expect(res.body.failure.screenshot).toBeUndefined();
    expect(res.body.failure.thumbnail).toBeUndefined();
    expect(res.text).not.toContain(tmpdir());
    const url = res.body.screenshotUrl as string;
    expect(url).toMatch(/^\/api\/playground\/shot\/[a-f0-9]{24}\.png$/);
    const image = await api('GET', url);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.body.subarray(0, 8).equals(PNG)).toBe(true);
    expect((await api('GET', url, { token: false })).status).toBe(401);
  });

  it('takes a screenshot of the final screen on request, and skips it while a password field is visible', async () => {
    const shot = await api.json('POST', '/api/playground/call', { tool: 'open_result', arguments: {}, preview: true });
    expect(shot.body.success).toBe(true);
    expect(shot.body.screenshotUrl).toMatch(/^\/api\/playground\/shot\/[a-f0-9]{24}\.png$/);
    expect((await api('GET', shot.body.screenshotUrl)).status).toBe(200);
    keptId = /([a-f0-9]{24})\.png$/.exec(shot.body.screenshotUrl)![1];
    const skipped = await api.json('POST', '/api/playground/call', { tool: 'open_login', arguments: {}, preview: true });
    expect(skipped.body).toMatchObject({ success: true, screenshotSkipped: 'sensitive_field' });
    expect(skipped.body.screenshotUrl).toBeUndefined();
    const off = await api.json('POST', '/api/playground/call', { tool: 'open_result', arguments: {}, preview: false });
    expect(off.body.screenshotUrl).toBeUndefined();
  });

  it('deletes the copied pictures when the Studio closes', async () => {
    // Other test files may have Studios of their own: find the folder that holds this one's picture
    const mine = shotDirs().filter((d) => existsSync(join(tmpdir(), d, `${keptId}.png`)));
    expect(mine).toHaveLength(1);
    await handle.close();
    expect(existsSync(join(tmpdir(), mine[0]))).toBe(false);
  });
});
