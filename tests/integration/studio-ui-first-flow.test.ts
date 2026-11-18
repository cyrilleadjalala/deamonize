import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { removeDir } from '../helpers/cleanup.js';
import { deriveSlug } from '../../src/studio/app-names.js';

// The first flow of a new user, end to end, in a real Chromium against the REAL Studio backend: no route of the
// feature APIs is intercepted. The recorded application is a small local fixture (a login with a password, then a
// search). The recording window of the Studio is driven through the browser object it launches.

const workspaceRoot = resolve(import.meta.dirname, '../..');
const PASSWORD = 'first-flow-pw-4471';
const SESSION = 'first-flow-session';

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1>
<form method="post" action="/login">
<label for="user">Username</label><input id="user" name="user" type="text" autocomplete="off">
<label for="pw">Password</label><input id="pw" name="pw" type="password" autocomplete="off">
<button type="submit">Sign in</button></form></body></html>`;
const ITEMS = ['Blue widget', 'Red widget', 'Green gadget'];
const homePage = (q: string): string => `<!doctype html><html><head><title>Items</title></head><body><h1 id="title">Items</h1>
<form method="get" action="/home"><label for="q">Search items</label><input id="q" name="q" type="search" autocomplete="off" value="${q.replace(/[^\w ]/g, '')}">
<button type="submit">Search</button></form>
<ul id="list">${ITEMS.filter((i) => i.toLowerCase().includes(q.toLowerCase())).map((i) => `<li>${i}</li>`).join('')}</ul></body></html>`;

describe('Studio first flow in a real browser, real backend', () => {
  let base: string;
  let dir: string;
  let appOut: string;
  let appData: string;
  let ws: string;
  let fixture: Server;
  let fixtureUrl: string;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;
  let studioBase: string;
  const recorderBrowsers: Browser[] = [];
  const consoleProblems: string[] = [];
  const pageErrors: string[] = [];
  const crossOrigin: string[] = [];
  const apiBodies: string[] = [];
  const apiUrls: string[] = [];
  let launchSpy: { mockRestore(): void } | undefined;
  let passwordSecretName = '';

  const open = async (hash: string): Promise<void> => {
    await page.goto('about:blank');
    await page.goto(`${studioBase}/${hash}`);
    await page.waitForSelector('main h1, main h2', { state: 'visible' });
    await page.waitForFunction(() => document.querySelector('main[aria-busy]') === null);
  };
  const live = (): Promise<string> => page.locator('#live').textContent().then((t) => t ?? '');

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'studio-first-flow-'));
    dir = join(base, 'project');
    appData = join(base, 'appdata');
    ws = join(base, 'kiro-workspace');
    await mkdir(join(dir, 'out'), { recursive: true });
    await mkdir(ws, { recursive: true });
    // Dependencies come from the repository, so the compile does not run npm install
    await symlink(join(workspaceRoot, 'node_modules'), join(dir, 'out', 'node_modules'), 'junction');

    fixture = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/login') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const pw = new URLSearchParams(body).get('pw');
          if (pw === PASSWORD) {
            res.writeHead(302, { location: '/home', 'set-cookie': `sid=${SESSION}; Path=/` });
            res.end();
          } else {
            res.writeHead(401, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>No</title><h1>Wrong password</h1>');
          }
        });
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/home') {
        if (!(req.headers.cookie ?? '').includes(`sid=${SESSION}`)) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.end(homePage(url.searchParams.get('q') ?? ''));
        return;
      }
      res.end(LOGIN_PAGE);
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/login`;
    // The tool of this application is built in its own folder next to `out`; give it the same dependencies
    appOut = join(dir, deriveSlug({ origin: new URL(fixtureUrl).origin }));
    await mkdir(appOut, { recursive: true });
    await symlink(join(workspaceRoot, 'node_modules'), join(appOut, 'node_modules'), 'junction');

    const chromiumEnv: Record<string, string> = process.env.DAEMONIZE_CHROMIUM_PATH ? { DAEMONIZE_CHROMIUM_PATH: process.env.DAEMONIZE_CHROMIUM_PATH } : {};
    studio = await startStudio({
      workflowFile: join(dir, 'daemonize.workflows.json'),
      outDir: join(dir, 'out'),
      env: { ...chromiumEnv, DAEMONIZE_DATA_DIR: appData, DAEMONIZE_VAULT_KEY_PROVIDER: 'file' },
    });
    studioBase = studio.origin;

    browser = await chromium.launch();
    // From here on, every chromium.launch call is the Studio's recording window: show it headless and keep a handle
    const original = chromium.launch.bind(chromium);
    launchSpy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const b = await original({ ...options, headless: true });
      recorderBrowsers.push(b);
      return b;
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (((window as unknown) as { __csp?: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleProblems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol.startsWith('http') && u.origin !== studioBase) crossOrigin.push(r.url());
    });
    page.on('response', (r) => {
      if (!r.url().startsWith(`${studioBase}/api/`)) return;
      apiUrls.push(r.url());
      r.text().then((t) => apiBodies.push(t), () => undefined);
    });
    await page.goto(studio.url);
    await page.waitForSelector('main h1, main h2');
  }, 180000);

  afterAll(async () => {
    launchSpy?.mockRestore();
    await browser?.close();
    for (const b of recorderBrowsers) await b.close().catch(() => undefined);
    await studio?.close();
    await new Promise<void>((done) => fixture?.close(() => done()));
    if (base) await removeDir(base);
  });

  it('shows the welcome screen when nothing is recorded yet', async () => {
    await open('#/');
    await expect.poll(() => page.locator('.welcome').count()).toBe(1);
    expect(await page.locator('#new-action-btn').count()).toBe(1);
    expect(await page.locator('.welcome').textContent()).toContain('Welcome to Daemonize');
    // Nothing was created by looking at an empty Studio
    await expect(stat(join(dir, 'daemonize.workflows.json'))).rejects.toThrow();
  });

  it('validates the new-action form in the browser before sending anything', async () => {
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/record/start')) posts.push(r.url());
    });
    await page.locator('#new-action-btn').click();
    await page.locator('#action-name').waitFor();
    await page.getByRole('button', { name: 'Start recording' }).click();
    expect(await page.locator('#action-name').getAttribute('aria-invalid')).toBe('true');
    expect(await page.locator('#action-url').getAttribute('aria-invalid')).toBe('true');
    await page.locator('#action-name').fill('Search items');
    await page.locator('#action-url').fill('ftp://example.com/');
    await page.getByRole('button', { name: 'Start recording' }).click();
    expect(await page.locator('#action-url').getAttribute('aria-invalid')).toBe('true');
    expect(posts).toEqual([]);
  });

  it('records the login and a search on a local app, makes the search a variable, and builds the tool', async () => {
    await page.locator('#action-url').fill(fixtureUrl);
    await page.getByRole('button', { name: 'Start recording' }).click();
    await page.waitForFunction(() => location.hash === '#/record');
    await expect.poll(() => page.locator('#record-state').textContent()).toContain('Recording');

    await expect.poll(() => recorderBrowsers.length, { timeout: 30000 }).toBe(1);
    const rec = (): Page => recorderBrowsers[0].contexts()[0].pages()[0];
    await expect.poll(async () => (await rec()?.locator('[data-daemonize-panel]').count().catch(() => 0)) ?? 0, { timeout: 30000 }).toBe(1);
    const r = rec();
    await r.locator('#user').click();
    await r.keyboard.type('demo');
    await r.locator('#pw').click();
    await r.keyboard.type(PASSWORD);
    await r.getByRole('button', { name: 'Sign in' }).click();
    await r.waitForURL('**/home');
    await r.locator('#q').click();
    await r.keyboard.type('widget');
    await r.locator('#title').click(); // leaving the field offers the variable
    await r.getByRole('button', { name: 'Make variable' }).click();
    await r.locator('[data-daemonize-action=variable-name]').press('Enter');
    await r.getByRole('button', { name: 'Search' }).click();
    await r.waitForURL('**/home?q=*');
    await r.getByRole('button', { name: 'Finish and save' }).click();
    // In a Studio recording the button opens the end sheet; "Save only" ends it without a next step
    await r.getByRole('button', { name: 'Save only' }).click();

    await expect.poll(() => page.locator('#test-it').count(), { timeout: 120000 }).toBe(1);
    await expect.poll(() => page.locator('#record-state').textContent()).toContain('Done');
    await expect.poll(live).toContain('Your tool is ready');
    // The workflow file exists and holds no password
    const file = await readFile(join(dir, 'daemonize.workflows.json'), 'utf-8');
    expect(file).not.toContain(PASSWORD);
    expect(JSON.parse(file).workflows).toHaveLength(1);
    const outFiles = await readdir(appOut);
    expect(outFiles).toContain('mcp-server.js');
  });

  it('saves the password in the credentials panel without leaving it anywhere visible', async () => {
    await open('#/credentials');
    const row = page.locator('[data-kind="password"]').first();
    await row.waitFor();
    passwordSecretName = (await row.getAttribute('data-secret')) ?? '';
    expect(passwordSecretName).not.toBe('');
    expect(await row.textContent()).toContain('has no value yet');
    const input = row.locator('input');
    await input.fill(PASSWORD);
    await row.locator('[data-action=save]').click();
    await expect.poll(() => row.textContent()).toContain('has a value');
    expect(await input.inputValue()).toBe('');
    await expect.poll(live).toContain('saved');
    expect(await page.content()).not.toContain(PASSWORD);
    expect(page.url()).not.toContain(PASSWORD);
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage, document.cookie]))).not.toContain(PASSWORD);
    // It survives a reload as "Configured", still with no value in the page
    await open('#/credentials');
    expect(await page.locator(`[data-secret="${passwordSecretName}"]`).textContent()).toContain('has a value');
    expect(await page.content()).not.toContain(PASSWORD);
  });

  it('opens the playground from "Test it" and a call succeeds', async () => {
    await open('#/record');
    await page.locator('#test-it').click();
    await page.waitForSelector('[data-playground]');
    await page.waitForFunction(() => document.querySelector('main .loading') === null);
    const field = page.locator('[id^="pg-f-"]').first();
    await field.waitFor({ timeout: 30000 });
    await field.fill('widget');
    await page.click('#pg-call');
    const ok = page.locator('section.pg-result[data-result="success"]');
    const confirm = page.locator('#pg-confirm-ok');
    await expect
      .poll(
        async () => {
          if (await confirm.isVisible().catch(() => false)) await confirm.click();
          return ok.count();
        },
        { timeout: 90000, intervals: [500] }
      )
      .toBe(1);
  });

  it('connects to Kiro without writing the password, with no placeholder for a stored one', async () => {
    await open('#/record');
    await page.locator('#connect-btn').waitFor();
    await page.locator('#connect-scope-project').check();
    await page.locator('#connect-folder').fill(ws);
    await page.locator('#connect-btn').click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor();
    await page.locator('#connect-confirm').click();
    await expect.poll(() => dialog.textContent(), { timeout: 20000 }).toContain('Your tool is connected');
    await page.locator('#connect-close').click();
    const text = await readFile(join(ws, '.kiro', 'settings', 'mcp.json'), 'utf-8');
    // The password is stored in the vault (previous test), so the entry needs no placeholder for it
    expect(text).not.toContain('${DAEMONIZE_SECRET_');
    expect(text).toContain('DAEMONIZE_APP_KEY');
    expect(text).not.toContain(PASSWORD);
  });

  it('left no secret in any API response, no console error, no CSP violation and no cross-origin request', async () => {
    await new Promise((r) => setTimeout(r, 500)); // let the last response bodies arrive
    expect(apiUrls.length).toBeGreaterThan(10);
    expect(apiBodies.filter((b) => b.includes(PASSWORD))).toEqual([]);
    expect(consoleProblems).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(crossOrigin).toEqual([]);
    expect(await page.evaluate(() => ((window as unknown) as { __csp?: string[] }).__csp ?? [])).toEqual([]);
  });
});
