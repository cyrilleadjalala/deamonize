import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compile } from '../../src/cli/commands/compile.js';
import { studio, parsePort } from '../../src/cli/commands/studio.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { SAMPLE_PNG } from '../../src/studio/sample-data.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { rawRequest, type RawResponse } from '../helpers/http.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const WF_ID = '12121212-1212-4212-8212-121212121212';
const ENV_SECRET = 'EnvSecret-Zq9-7f3a91c2';
const COOKIE_SECRET = 'CookieValue-Zq9-55d0e8a1';
const OUTSIDE = 'OUTSIDE-SECRET-CONTENT';

const set: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: 'Legacy CRM',
  startUrl: 'http://localhost:8080/',
  storageState: 'auth/state.json',
  workflows: [
    {
      id: WF_ID,
      label: 'Create customer',
      steps: [
        { actionType: 'type', selectors: ['#password'], secretRef: 'CRM_PASSWORD', label: 'Password', anchor: { role: 'textbox', name: 'Password', frame: [] } },
        {
          actionType: 'type',
          selectors: ['#email'],
          variable: 'email',
          label: 'E-mail',
          anchor: { role: 'textbox', name: 'E-mail', frame: [] },
          visual: { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, intent: 'the e-mail field', thumbnailPath: `workflows.json.assets/step-${WF_ID}-1.png` },
        },
        { actionType: 'click', selectors: ['#save'], risk: 'write', label: 'Save', anchor: { role: 'button', name: 'Save', frame: [] } },
      ],
      variables: [{ name: 'email', description: 'Customer e-mail' }],
      secrets: [{ name: 'CRM_PASSWORD', kind: 'password' }],
      observedPayloads: [{ email: 'a@example.com' }],
    },
  ],
};

describe('Studio server', () => {
  let dir: string;
  let studioDir: string;
  let handle: StudioHandle;
  let out: string;

  const call = (path: string, options: { method?: string; token?: string | null; headers?: Record<string, string>; host?: string; h?: StudioHandle } = {}): Promise<RawResponse> => {
    const target = options.h ?? handle;
    const headers: Record<string, string> = { host: options.host ?? `127.0.0.1:${target.port}`, ...(options.headers ?? {}) };
    if (options.token !== null) headers['x-studio-token'] = options.token ?? target.token;
    return rawRequest(target, options.method ?? 'GET', path, headers);
  };

  beforeAll(async () => {
    // Under the workspace so the generated tests find vitest, fast-check and ajv in node_modules
    dir = await mkdtemp(join(workspaceRoot, '.studio-'));
    out = join(dir, 'out');
    const file = join(dir, 'workflows.json');
    await writeFile(file, serializeWorkflowSet(set));
    await mkdir(join(dir, 'workflows.json.assets'), { recursive: true });
    await writeFile(join(dir, 'workflows.json.assets', `step-${WF_ID}-1.png`), SAMPLE_PNG);
    await writeFile(join(dir, 'workflows.json.assets', 'unreferenced.png'), SAMPLE_PNG);
    await mkdir(join(dir, 'auth'), { recursive: true });
    await writeFile(join(dir, 'auth', 'state.json'), JSON.stringify({ cookies: [{ name: 'sid', value: COOKIE_SECRET, domain: 'localhost', path: '/' }], origins: [] }));

    const log = console.log;
    console.log = () => { };
    try {
      await compile(file, out);
    } finally {
      console.log = log;
    }

    studioDir = join(dir, 'ui');
    await mkdir(join(studioDir, 'sub'), { recursive: true });
    await writeFile(join(studioDir, 'index.html'), '<!doctype html><title>ui</title>');
    await writeFile(join(studioDir, 'app.js'), 'console.log(1)');
    await writeFile(join(dir, 'outside.txt'), OUTSIDE);
    try {
      await symlink(join(dir, 'outside.txt'), join(studioDir, 'link.txt'), 'file');
    } catch {
      // Creating a file symlink may need a privilege on Windows
    }
    try {
      await mkdir(join(dir, 'outside-dir'), { recursive: true });
      await writeFile(join(dir, 'outside-dir', 'x.txt'), OUTSIDE);
      await symlink(join(dir, 'outside-dir'), join(studioDir, 'linkdir'), 'junction');
    } catch {
      // Same
    }

    handle = await startStudio({
      workflowFile: file,
      outDir: out,
      staticDir: studioDir,
      env: { DAEMONIZE_SECRET_CRM_PASSWORD: ENV_SECRET },
      pbtTimeoutMs: 100000,
    });
  }, 120000);

  afterAll(async () => {
    await handle?.close();
    if (dir) await removeDir(dir);
  });

  describe('access control', () => {
    it('prints a url on loopback with the token', () => {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{20,}$/);
    });

    it('answers 401 to every api call without the token, or with a wrong one', async () => {
      for (const path of ['/api/health', '/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt', '/api/assets/x.png', '/api/unknown']) {
        expect((await call(path, { token: null })).status, path).toBe(401);
        expect((await call(path, { token: 'wrong-token' })).status, path).toBe(401);
      }
      expect((await call('/api/pbt/run', { method: 'POST', token: null })).status).toBe(401);
    });

    it('does not accept the token in the query of an api call', async () => {
      expect((await call(`/api/health?token=${handle.token}`, { token: null })).status).toBe(401);
    });

    it('rejects a wrong Host header even with the token (DNS rebinding)', async () => {
      for (const host of ['evil.example', `evil.example:${handle.port}`, '127.0.0.1', `127.0.0.1.evil.example:${handle.port}`]) {
        expect((await call('/api/health', { host })).status, host).toBe(403);
        expect((await call('/', { host, token: null })).status, host).toBe(403);
      }
      expect((await call('/api/health', { host: `localhost:${handle.port}` })).status).toBe(200);
    });

    it('rejects a foreign Origin and sends no CORS header', async () => {
      const foreign = await call('/api/health', { headers: { origin: 'https://evil.example' } });
      expect(foreign.status).toBe(403);
      const same = await call('/api/health', { headers: { origin: handle.origin } });
      expect(same.status).toBe(200);
      expect(Object.keys(same.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      const preflight = await call('/api/health', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
      expect(preflight.status).toBe(403);
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('sets a cookie on the first visit and accepts it for GET, but not for a POST without the marker', async () => {
      const first = await call(`/?token=${handle.token}`, { token: null });
      expect(first.status).toBe(302);
      expect(first.headers.location).toBe('/');
      const cookie = String(first.headers['set-cookie']).split(';')[0];
      expect(String(first.headers['set-cookie'])).toMatch(/HttpOnly/);
      expect(String(first.headers['set-cookie'])).toMatch(/SameSite=Strict/);
      expect((await call('/api/health', { token: null, headers: { cookie } })).status).toBe(200);
      expect((await call('/api/pbt/run', { method: 'POST', token: null, headers: { cookie } })).status).toBe(401);
      expect((await call('/', { token: null }).then((r) => r.status))).toBe(200);
      expect((await call('/?token=bad', { token: null })).status).toBe(401);
    });

    it('sends restrictive security headers', async () => {
      const r = await call('/', { token: null });
      expect(r.headers['content-security-policy']).toContain("default-src 'self'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-frame-options']).toBe('DENY');
      const api = await call('/api/health');
      expect(api.headers['content-security-policy']).toContain("default-src 'self'");
    });

    it('allows only GET on data endpoints and POST on /api/pbt/run', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        expect((await call('/api/overview', { method })).status, method).toBe(405);
      }
      expect((await call('/api/pbt/run', { method: 'GET' })).status).toBe(405);
      expect((await call('/', { method: 'DELETE', token: null })).status).toBe(405);
    });

    it('limits the size of the request', async () => {
      expect((await call('/api/pbt/run', { method: 'POST', headers: { 'content-length': '100000' } })).status).toBe(413);
      expect((await call(`/api/health?${'a'.repeat(3000)}`)).status).toBe(414);
    });
  });

  describe('static files', () => {
    it('serves the index and a file of the static folder', async () => {
      const index = await call('/', { token: null });
      expect(index.status).toBe(200);
      expect(index.headers['content-type']).toContain('text/html');
      expect(index.text).toContain('<title>ui</title>');
      const js = await call('/app.js', { token: null });
      expect(js.headers['content-type']).toContain('text/javascript');
    });

    it('never serves a file outside the static folder', async () => {
      const attempts = [
        '/../outside.txt',
        '/%2e%2e/outside.txt',
        '/%2e%2e%2foutside.txt',
        '/..%2foutside.txt',
        '/..%5coutside.txt',
        '/..\\outside.txt',
        '/%252e%252e/outside.txt',
        '/sub/../../outside.txt',
        '//outside.txt',
        `/${join(dir, 'outside.txt').replace(/\\/g, '/')}`,
        `/${join(dir, 'outside.txt').replace(/\\/g, '/')}`.replace(/^\/([A-Za-z]):/, '/$1%3A'),
        '/C:/Windows/win.ini',
        '/%00',
        '/app.js%00.png',
        '/link.txt',
        '/linkdir/x.txt',
      ];
      for (const path of attempts) {
        const r = await call(path, { token: null }).catch(() => undefined);
        if (r === undefined) continue;
        expect([301, 302].includes(r.status) ? 404 : r.status, path).toBeGreaterThanOrEqual(400);
        expect(r.status, path).toBeLessThan(500);
        expect(r.text, path).not.toContain(OUTSIDE);
      }
    });
  });

  describe('data', () => {
    it('reports the overview with mode flags', async () => {
      const r = await call('/api/overview');
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(body).toMatchObject({ sample: false, targetType: 'web', targetName: 'Legacy CRM' });
      expect(body.targets[0]).toMatchObject({
        workflows: 1,
        steps: 3,
        storageState: 'state.json',
        modes: { compiled: true, strict: true, healSupport: false, http: false },
        testsGenerated: true,
        secrets: ['CRM_PASSWORD'],
      });
    });

    it('lists workflows with levels, secret names only and a thumbnail url', async () => {
      const body = JSON.parse((await call('/api/workflows')).text);
      const w = body.workflows[0];
      expect(w).toMatchObject({ id: WF_ID, toolName: 'create_customer', secrets: [{ name: 'CRM_PASSWORD', kind: 'password' }] });
      expect(w.risk.highest).toBe('write');
      // The environment of the Studio holds DAEMONIZE_SECRET_CRM_PASSWORD: configured, and only the word is returned
      expect(w.secrets).toEqual([{ name: 'CRM_PASSWORD', kind: 'password', envVariable: 'DAEMONIZE_SECRET_CRM_PASSWORD', status: 'configured' }]);
      expect(w).toMatchObject({ unusedSecrets: [], secretsBasis: 'ui-only' });
      expect(Array.isArray(w.writeSteps)).toBe(true);
      expect(['none', 'login-only', 'actions']).toContain(w.writeSummary);
      expect(w.steps[0]).toMatchObject({ usesSecret: true, primaryLevel: 'accessibility' });
      expect(w.steps[1].levels).toEqual({ http: false, accessibility: true, vision: true, coordinates: true });
      expect(w.steps[1].thumbnailUrl).toBe(`/api/assets/step-${WF_ID}-1.png`);
      expect(w.steps[0].thumbnailUrl).toBeUndefined();
    });

    it('serves graph and schemas', async () => {
      const graph = JSON.parse((await call('/api/graph')).text);
      expect(graph.source).toBe('workflows');
      expect(graph.nodes.length).toBe(4);
      const schemas = JSON.parse((await call('/api/schemas')).text);
      expect(schemas.tools[0]).toMatchObject({ toolName: 'create_customer', openapiPath: `/actions/${WF_ID}` });
      expect(schemas.tools[0].inputSchema.properties.email).toBeDefined();
      expect(schemas.openapi[0].paths[0]).toMatchObject({ method: 'POST', operationId: 'create_customer' });
    });

    it('uses a State_Graph file next to the output when there is one', async () => {
      await writeFile(join(out, 'state-graph.json'), JSON.stringify({ version: '1', screens: { aa: { id: 'aa', type: 'dom', snapshot: OUTSIDE, label: 'Home', observationCount: 1 } }, transitions: [] }));
      const graph = await call('/api/graph');
      expect(JSON.parse(graph.text)).toMatchObject({ source: 'state-graph', nodes: [{ id: 'aa', label: 'Home' }] });
      expect(graph.text).not.toContain(OUTSIDE);
    });

    it('never returns the environment secret, the storage state values or the planted paths', async () => {
      for (const path of ['/api/overview', '/api/workflows', '/api/graph', '/api/schemas', '/api/pbt']) {
        const text = (await call(path)).text;
        expect(text, path).not.toContain(ENV_SECRET);
        expect(text, path).not.toContain(COOKIE_SECRET);
        expect(text, path).not.toContain('auth/state.json');
      }
    });

    it('answers a clear error when the workflow file is missing, without its path', async () => {
      const broken = await startStudio({ workflowFile: join(dir, 'missing-file.json'), outDir: out, staticDir: studioDir });
      try {
        const r = await call('/api/overview', { h: broken });
        expect(r.status).toBe(500);
        expect(JSON.parse(r.text).error).toBe('workflow file not found: missing-file.json');
        expect(r.text).not.toContain(dir);
      } finally {
        await broken.close();
      }
    });
  });

  describe('assets route', () => {
    it('serves a referenced thumbnail as image/png', async () => {
      const r = await call(`/api/assets/step-${WF_ID}-1.png`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.body.equals(SAMPLE_PNG)).toBe(true);
    });

    it('refuses everything else: unreferenced files, other types, traversal, odd names', async () => {
      const names = [
        'unreferenced.png',
        '..%2fworkflows.json',
        '%2e%2e%2fworkflows.json',
        '..%5cworkflows.json',
        'step-' + WF_ID + '-1.png%00.txt',
        'step-' + WF_ID + '-1.PNG.txt',
        'step-' + WF_ID + '-1.jpg',
        `..%2fout%2fopenapi.json`,
        '.png',
        'a.b.png',
        encodeURIComponent(join(dir, 'workflows.json')),
      ];
      for (const name of names) {
        const r = await call(`/api/assets/${name}`);
        expect(r.status, name).toBe(404);
      }
    });
  });

  describe('property tests', () => {
    it('has no result before a run, and lists the generated tools', async () => {
      const body = JSON.parse((await call('/api/pbt')).text);
      expect(body).toMatchObject({ available: false, running: false, generatedTools: ['create_customer'] });
    });

    it('runs the generated suite, stores the result, and allows one run at a time', async () => {
      const first = call('/api/pbt/run', { method: 'POST' });
      // Wait until the server says it is running, then ask for a second run
      let running = false;
      for (let i = 0; i < 100 && !running; i++) {
        running = JSON.parse((await call('/api/pbt')).text).running === true;
        if (!running) await new Promise((r) => setTimeout(r, 50));
      }
      expect(running).toBe(true);
      const second = await call('/api/pbt/run', { method: 'POST' });
      expect(second.status).toBe(409);

      const done = await first;
      expect(done.status, done.text).toBe(200);
      const body = JSON.parse(done.text);
      expect(body.available).toBe(true);
      expect(body.result.status, done.text).toBe('passed');
      expect(body.result.tools).toEqual([{ tool: 'create_customer', passing: 2, failing: 0, skipped: 0, counterexamples: [] }]);
      expect(body.result.totals).toEqual({ passing: 2, failing: 0, skipped: 0 });

      const stored = JSON.parse(await readFile(join(out, '.daemonize', 'pbt-result.json'), 'utf-8'));
      expect(stored.status).toBe('passed');
      const again = JSON.parse((await call('/api/pbt')).text);
      expect(again).toMatchObject({ available: true, running: false });
      expect(again.result.tools[0].passing).toBe(2);
    });
  });

  describe('sample mode', () => {
    let sample: StudioHandle;
    beforeAll(async () => {
      sample = await startStudio({ sampleData: true, workflowFile: join(dir, 'does-not-exist.json'), outDir: join(dir, 'nope'), staticDir: studioDir });
    });
    afterAll(async () => {
      await sample.close();
    });

    it('serves fictitious data without reading any file', async () => {
      const overview = JSON.parse((await call('/api/overview', { h: sample })).text);
      expect(overview.sample).toBe(true);
      expect(overview.targets.map((t: { type: string }) => t.type)).toEqual(['web', 'tui']);
      const { workflows } = JSON.parse((await call('/api/workflows', { h: sample })).text);
      expect(workflows).toHaveLength(4);
      const levels = new Set(workflows.flatMap((w: { steps: Array<{ primaryLevel: string }> }) => w.steps.map((s) => s.primaryLevel)));
      expect(levels).toEqual(new Set(['http', 'accessibility', 'vision', 'terminal']));
      expect(JSON.parse((await call('/api/graph', { h: sample })).text).source).toBe('state-graph');
      expect(JSON.parse((await call('/api/schemas', { h: sample })).text).tools).toHaveLength(4);
      const pbt = JSON.parse((await call('/api/pbt', { h: sample })).text);
      expect(pbt.result.totals.failing).toBe(1);
    });

    it('serves a placeholder picture for a sample thumbnail only, and cannot run the suite', async () => {
      const { workflows } = JSON.parse((await call('/api/workflows', { h: sample })).text);
      const url = workflows[0].steps[0].thumbnailUrl as string;
      expect(url).toMatch(/^\/api\/assets\/sample-/);
      const png = await call(url, { h: sample });
      expect(png.status).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect((await call('/api/assets/other.png', { h: sample })).status).toBe(404);
      expect((await call('/api/pbt/run', { method: 'POST', h: sample })).status).toBe(409);
    });
  });

  describe('lifecycle and remote hosts', () => {
    it('frees the port on close()', async () => {
      const h = await startStudio({ sampleData: true, staticDir: studioDir });
      const { port } = h;
      await h.close();
      await new Promise<void>((done, fail) => {
        const probe = createServer();
        probe.once('error', fail);
        probe.listen(port, '127.0.0.1', () => probe.close(() => done()));
      });
      await expect(call('/api/health', { h })).rejects.toThrow();
    });

    it('refuses a host that is not loopback without allowRemote', async () => {
      await expect(startStudio({ sampleData: true, host: '0.0.0.0' })).rejects.toThrow(/allow-remote/);
      await expect(startStudio({ sampleData: true, host: '192.168.1.20' })).rejects.toThrow(/allow-remote/);
    });

    it('refuses an invalid port', async () => {
      await expect(startStudio({ sampleData: true, port: 70000 })).rejects.toThrow(/port/i);
      expect(() => parsePort('abc')).toThrow(/--port/);
      expect(parsePort('4173')).toBe(4173);
    });

    it('the command refuses a remote host without --allow-remote and prints the url with the token', async () => {
      await expect(studio('out', { workflows: 'w.json', host: '0.0.0.0', sample: true })).rejects.toThrow(/--allow-remote/);
      const lines: string[] = [];
      const h = await studio('out', { workflows: 'w.json', sample: true, log: (l) => lines.push(l) });
      try {
        expect(lines.join('\n')).toContain(h.url);
        expect(h.url).toContain('?token=');
      } finally {
        await h.close();
      }
    });
  });
});
