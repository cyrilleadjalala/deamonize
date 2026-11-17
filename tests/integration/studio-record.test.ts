import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createAppData } from '../../src/studio/app-data.js';
import { createCompileRunner } from '../../src/studio/compile-runner.js';
import { createRecordingManager, defaultRecord, type RecordFn } from '../../src/studio/recording-manager.js';
import { createSessionStore } from '../../src/studio/session-store.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import type { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { rawRequest } from '../helpers/http.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const workspaceRoot = resolve(import.meta.dirname, '../..');
const COOKIE_VALUE = 'studio-record-session-value-789';
const TYPED = 'typed-private-value-424242';

// "/" has a field and a link; "/login" sets a cookie (the "sign in") and links back
const HOME = '<!doctype html><html><head><title>Home</title></head><body><label for="e">Email</label><input id="e" type="text"/><a href="/login">Sign in</a></body></html>';
const LOGIN = '<!doctype html><html><head><title>Signed in</title></head><body><a href="/">Home page</a></body></html>';

describe('Studio recording with a real browser, record() and the Compile_Runner', () => {
  let site: Server;
  let url: string;
  let base: string;
  let handle: StudioHandle | undefined;
  let live: LiveRecorder | undefined;
  let browser: Browser | undefined;
  let workflowFile: string;
  let out: string;

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url?.startsWith('/login')) {
        res.setHeader('set-cookie', `sid=${COOKIE_VALUE}; Path=/`);
        res.end(LOGIN);
      } else res.end(HOME);
    });
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
    base = await mkdtemp(join(tmpdir(), 'studio-record-'));
    out = join(base, 'out');
    workflowFile = join(base, 'daemonize.workflows.json');
    await mkdir(join(base, 'ui'), { recursive: true });
    await mkdir(out, { recursive: true });
    // Stand-in for "npm install": the compile runner skips the installation when node_modules exists
    await symlink(join(workspaceRoot, 'node_modules'), join(out, 'node_modules'), 'junction');

    const env = { DAEMONIZE_DATA_DIR: join(base, 'appdata') };
    const appData = createAppData({ cwd: process.cwd(), outDir: out, env });
    const sessions = createSessionStore({ appData });
    const compiler = createCompileRunner({ workflowFile, target: async () => ({ outDir: out, slug: 'app' }), playground: () => undefined, scrub: (t) => t, paths: [base] });
    // The real record(), seen through its hooks so the test can drive the page like a user
    const record: RecordFn = (options) =>
      defaultRecord({
        ...options,
        onLive: (l) => { live = l as LiveRecorder; options.onLive(l); },
        onBrowser: (b) => { browser = b as Browser; options.onBrowser(b); },
      });
    const recording = createRecordingManager({
      workflowFile, sessions, compiler, scrub: (t) => t, record,
      // Headless so the suite runs without a display
      launch: (o: Parameters<typeof chromium.launch>[0]) =>
        chromium.launch({ ...o, headless: true, executablePath: o?.executablePath ?? (process.env.DAEMONIZE_CHROMIUM_PATH || undefined) }),
    });
    handle = await startStudio({ workflowFile, outDir: out, staticDir: join(base, 'ui'), env, services: { appData, sessions, compiler, recording } });
  }, 60000);

  afterEach(async () => {
    // Make sure no session is left over, whatever happened
    if (handle !== undefined) await call('POST', '/api/record/stop').catch(() => undefined);
    for (let i = 0; i < 400; i += 1) {
      const s = (await call('GET', '/api/record/status')).json?.state;
      if (s !== 'recording' && s !== 'saving' && s !== 'compiling') break;
      await sleep(50);
    }
  });

  afterAll(async () => {
    await handle?.close();
    await new Promise<void>((done) => site?.close(() => done()));
    await removeDir(base);
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const call = async (method: string, path: string, body?: unknown) => {
    const h = handle!;
    const res = await rawRequest(
      h, method, path,
      { host: `127.0.0.1:${h.port}`, 'x-studio-token': h.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body === undefined ? undefined : JSON.stringify(body)
    );
    return { status: res.status, text: res.text, json: res.text === '' ? undefined : (JSON.parse(res.text) as Record<string, any>) };
  };
  const pageOf = (): Page => browser!.contexts()[0].pages()[0];
  const startRecording = async (name: string) => {
    live = undefined;
    const res = await call('POST', '/api/record/start', { name, url, reuseSession: true });
    expect(res.status).toBe(202);
    for (let i = 0; i < 600 && live === undefined; i += 1) await sleep(50);
    expect(live).toBeDefined();
    return res;
  };
  const clickSignIn = async (typed?: string) => {
    const page = pageOf();
    if (typed !== undefined) await page.getByLabel('Email').fill(typed);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL('**/login');
    await live!.idle();
  };
  /** Polls the status until `done`, returning the distinct states seen in order. */
  const follow = async (until: (s: Record<string, any>) => boolean) => {
    const seen: string[] = [];
    let last: Record<string, any> = {};
    for (let i = 0; i < 3000; i += 1) {
      last = (await call('GET', '/api/record/status')).json ?? {};
      if (seen[seen.length - 1] !== last.state) seen.push(last.state);
      if (until(last)) break;
      await sleep(10);
    }
    return { seen, last };
  };
  const isFinal = (s: Record<string, any>) => s.state === 'done' || s.state === 'error';

  it('records, refuses a second start, stops through the API, compiles and saves the session', async () => {
    const started = await startRecording('Sign in to the app');
    expect(started.json).toEqual({ state: 'recording' });
    expect((await call('POST', '/api/record/start', { name: 'Another', url })).status).toBe(409);

    await clickSignIn(TYPED);
    const status = await call('GET', '/api/record/status');
    expect(status.json?.state).toBe('recording');
    expect(status.json?.steps).toBeGreaterThanOrEqual(1);
    expect(status.json?.labels.length).toBeLessThanOrEqual(3);
    expect(status.text).not.toContain(TYPED);
    expect(status.text).not.toContain(COOKIE_VALUE);

    const stop = await call('POST', '/api/record/stop');
    expect(stop.status).toBe(202);
    expect(stop.json).toEqual({ state: 'saving' });
    expect((await call('POST', '/api/record/stop')).status).toBe(409);

    const { seen, last } = await follow(isFinal);
    expect(last.state).toBe('done');
    expect(seen).toEqual(['saving', 'compiling', 'done']);

    const text = await readFile(workflowFile, 'utf-8');
    expect(deserializeWorkflowSet(text).workflows.length).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain(COOKIE_VALUE);
    // (a typed example value of a plain field is part of the recorded workflow by design; only the status hides it)
    expect(existsSync(join(out, 'mcp-server.js'))).toBe(true);

    const key = new URL(url).origin;
    expect((await call('GET', `/api/sessions?key=${encodeURIComponent(key)}`)).json).toEqual({ applicationKey: key, available: true });
  });

  it('reuses the saved session and ends through "Finish and save" in the panel', async () => {
    await startRecording('Sign in again');
    // The cookie comes from the saved session only: "/" never sets it
    expect(await pageOf().evaluate(() => document.cookie)).toContain(COOKIE_VALUE);
    await clickSignIn();
    await pageOf().getByRole('button', { name: 'Finish and save' }).click();

    const { seen, last } = await follow(isFinal);
    expect(last.state).toBe('done');
    expect(seen[seen.length - 1]).toBe('done');
    expect(seen).toContain('compiling');
    expect(last.sessionNote).toBeUndefined();
  });

  it('keeps the recovery file when the window is closed after steps', async () => {
    await startRecording('Close early');
    await clickSignIn();
    await pageOf().close();

    const { last } = await follow(isFinal);
    expect(last.state).toBe('error');
    expect(last.steps).toBeGreaterThanOrEqual(1);
    expect(typeof last.recoveryFile).toBe('string');
    expect(existsSync(last.recoveryFile)).toBe(true);
    expect(last.error).not.toContain(base);
    const recovery = await readFile(last.recoveryFile, 'utf-8');
    expect(deserializeWorkflowSet(recovery).workflows[0].steps.length).toBeGreaterThanOrEqual(1);
    expect(recovery).not.toContain(COOKIE_VALUE);
  });
});
