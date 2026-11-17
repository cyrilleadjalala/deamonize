import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

/**
 * A fake SPA: a link changes the route with pushState, and the new screen sends its mount request.
 * Feature: studio-first-recording-fixes, Property 8: Bug Condition - A navigation click does not take a mount read as its recipe
 */
const PAGE = `<!doctype html><title>App</title>
<nav>
  <a id="clients" href="/clients">Clients</a>
  <a id="logout" href="/login">Sign out</a>
  <a id="filter" href="/?q=1">Filter</a>
  <label for="q">Search</label><input id="q" name="q" />
  <a id="results" href="/results">Show results</a>
</nav>
<main id="view">home</main>
<script>
const show = (path, text) => { history.pushState({}, '', path); document.getElementById('view').textContent = text; };
const link = (id, handler) => document.getElementById(id).addEventListener('click', (e) => { e.preventDefault(); handler(); });
link('clients', () => { show('/clients', 'clients'); fetch('/api/merchants/audience'); });
link('logout', () => { fetch('/api/logout', { method: 'POST' }).then(() => { show('/login', 'login'); fetch('/api/login/config'); }); });
link('filter', () => { show('/?q=1', 'filtered'); fetch('/api/filter-options'); });
link('results', () => { const q = document.getElementById('q').value; show('/results', 'results'); fetch('/api/search?q=' + encodeURIComponent(q)); });
</script>`;

describe('finalizeNetwork on a screen navigation (fake SPA, real browser)', () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  async function record(act: (page: Page, live: LiveRecorder) => Promise<void>) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/`);
      const recorder = new WorkflowRecorder('Spa');
      const live = new LiveRecorder(page, recorder, { captureNetwork: true });
      await live.attach();
      await act(page, live);
      await page.waitForTimeout(700);
      await live.idle();
      const report = await live.finalizeNetwork();
      return { report, workflow: recorder.finish() };
    } finally {
      await context.close();
    }
  }

  it('leaves a navigation click without the mount GET of the new screen as its recipe', async () => {
    const { report, workflow } = await record(async (page) => {
      await page.getByRole('link', { name: 'Clients' }).click();
    });
    const click = workflow.steps.find((s) => s.actionType === 'click');
    // Counterexample on unfixed wiring: GET /api/merchants/audience is attached to the navigation click
    expect(click?.http).toBeUndefined();
    const entry = report.find((r) => r.step === 0);
    expect(entry?.level).toBe('accessibility');
    expect(entry?.reason).toMatch(/screen navigation/);
  });

  it('keeps the POST of a navigation click and ignores the mount GET that follows', async () => {
    const { workflow } = await record(async (page) => {
      await page.getByRole('link', { name: 'Sign out' }).click();
    });
    const click = workflow.steps.find((s) => s.actionType === 'click');
    expect(click?.http).toMatchObject({ method: 'POST' });
    expect(click?.http?.url).toMatch(/\/api\/logout$/);
  });

  it('keeps the recipe of a click that changes only the query string', async () => {
    const { workflow } = await record(async (page) => {
      await page.getByRole('link', { name: 'Filter' }).click();
    });
    const click = workflow.steps.find((s) => s.actionType === 'click');
    expect(click?.http?.url).toMatch(/\/api\/filter-options$/);
  });

  it('keeps the recipe of a navigation click that carries a variable', async () => {
    const { workflow } = await record(async (page, live) => {
      await page.locator('#q').click();
      await page.keyboard.type('Ada');
      await page.getByRole('link', { name: 'Show results' }).click();
      await page.waitForTimeout(300);
      live.markVariable(0, { name: 'query' });
    });
    const click = workflow.steps.find((s) => s.actionType === 'click');
    expect(click?.http?.url).toMatch(/\/api\/search/);
    expect(click?.http?.bindings?.map((b) => b.variable)).toEqual(['query']);
  });
});
