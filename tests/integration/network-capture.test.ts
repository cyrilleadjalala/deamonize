import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });
import { chromium, type Browser } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BEARER, COOKIE_VALUE, startCustomersApp, type CustomersApp } from '../helpers/customers-app.js';

describe('network capture and Level 1 recipes (record in a real browser)', () => {
  let app: CustomersApp;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    app = await startCustomersApp();
    baseUrl = app.baseUrl;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
  });

  it('records recipes for the API calls, falls back for the SSR form, and stores no credential', async () => {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'sid', value: COOKIE_VALUE, url: baseUrl }]);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await page.getByText('Bob').waitFor();

    const recorder = new WorkflowRecorder('Customers');
    const live = new LiveRecorder(page, recorder, { captureNetwork: true });
    await live.attach();

    // Search
    await page.locator('#q').click();
    await page.keyboard.type('Ada');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForTimeout(700);
    // Add
    await page.locator('#cname').click();
    await page.keyboard.type('Zed');
    await page.locator('#cemail').click();
    await page.keyboard.type('zed@example.com');
    await page.getByRole('button', { name: 'Add customer' }).click();
    await page.getByText('Zed').waitFor();
    await page.waitForTimeout(700);
    // Delete the row of Zed (id 3)
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'customer_id', rowText: '3' })).toEqual({ ok: true });
    await page.locator('tr', { hasText: 'Zed' }).getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(700);
    // Server-rendered form
    await page.locator('#ssr').click();
    await page.keyboard.type('Grace');
    await page.getByRole('button', { name: 'Save SSR' }).click();
    await page.waitForURL('**/ssr/customers');
    await page.waitForTimeout(300);

    const before = recorder.stepsSoFar();
    expect(before.map((s) => s.actionType)).toEqual(['type', 'click', 'type', 'type', 'click', 'click', 'type', 'click']);
    live.markVariable(0, { name: 'query' });
    live.markVariable(2, { name: 'cname' });
    live.markVariable(3, { name: 'cemail' });
    live.markVariable(6, { name: 'ssr_name' });

    const report = await live.finalizeNetwork();
    const workflow: Workflow = recorder.finish();
    await context.close();

    const [search, add, del, ssr] = workflow.steps.filter((s) => s.actionType === 'click');

    expect(search.http).toMatchObject({
      method: 'GET',
      url: `${baseUrl}/api/customers`,
      query: { q: '{{query}}' },
      bindings: [{ variable: 'query', in: 'query', name: 'q' }],
      headers: { authorization: { $secret: 'AUTHORIZATION' } },
      auth: 'env:AUTHORIZATION',
      expectStatus: 200,
    });
    expect(search.http?.responseShape).toMatchObject({
      type: 'object',
      properties: { customers: { type: 'array' }, total: { type: 'integer' } },
    });
    expect(search.risk).toBe('read');

    expect(add.http).toMatchObject({
      method: 'POST',
      url: `${baseUrl}/api/customers`,
      body: { name: { $var: 'cname' }, email: { $var: 'cemail' } },
      bindings: [
        { variable: 'cname', in: 'body', name: '/name' },
        { variable: 'cemail', in: 'body', name: '/email' },
      ],
      expectStatus: 201,
    });
    expect(add.http?.headers?.['content-type']).toBe('application/json');
    expect(add.risk).toBe('write');

    expect(del.http).toMatchObject({
      method: 'DELETE',
      url: `${baseUrl}/api/customers/{{customer_id}}`,
      bindings: [{ variable: 'customer_id', in: 'path', name: '3' }],
    });
    expect(del.risk).toBe('delete');

    // The server-rendered form made no fetch/XHR: Level 2 only
    expect(ssr.http).toBeUndefined();
    expect(report.filter((r) => r.level === 'http').map((r) => r.step)).toEqual([1, 4, 5]);
    expect(report.find((r) => r.step === 7)).toMatchObject({ level: 'accessibility' });
    expect(report.find((r) => r.step === 7)?.reason).toMatch(/server-rendered/);

    // Nothing but the three API calls was kept: no assets, analytics, polling or refreshes
    const recipes = workflow.steps.filter((s) => s.http !== undefined);
    expect(recipes).toHaveLength(3);
    const text = JSON.stringify(workflow);
    expect(text).not.toMatch(/analytics|icon\.png|\/api\/health/);

    // The workflow file holds no credential, and loads back
    const set: WorkflowSet = { version: '1', targetType: 'web', targetName: 'customers', startUrl: `${baseUrl}/`, workflows: [workflow] };
    const file = serializeWorkflowSet(set);
    expect(file).not.toContain(COOKIE_VALUE);
    expect(file).not.toContain(BEARER);
    expect(file).not.toMatch(/cookie/i);
    expect(deserializeWorkflowSet(file).workflows[0].steps[1].http?.method).toBe('GET');
  });
  it('keeps the login POST over a later dashboard GET and ignores an HMR fetch (Next-like page)', async () => {
    const page_html = `<!doctype html><title>Login</title>
<form id="f"><label for="code">Code</label><input id="code" name="code" />
<button type="submit">Verify</button></form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/auth/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
  setTimeout(() => fetch('/api/settings/system').then((r) => r.json()), 300);
  setTimeout(() => fetch('/_next/static/webpack/abc123.webpack.hot-update.json').catch(() => {}), 400);
});
</script>`;
    const json = (res: import('node:http').ServerResponse, body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page_html);
      } else if (path === '/api/auth/login/verify') json(res, { user: 'u' });
      else if (path === '/api/settings/system') json(res, { theme: 'dark' });
      else if (path.endsWith('.hot-update.json')) json(res, { c: [] });
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${url}/`);
      const recorder = new WorkflowRecorder('Login');
      const live = new LiveRecorder(page, recorder, { captureNetwork: true });
      await live.attach();
      await page.locator('#code').click();
      await page.keyboard.type('123456');
      await page.getByRole('button', { name: 'Verify' }).click();
      await page.waitForTimeout(1200);
      await live.idle();
      const report = await live.finalizeNetwork();
      const workflow = recorder.finish();
      await context.close();
      const click = workflow.steps.find((s) => s.actionType === 'click');
      expect(click?.http).toMatchObject({ method: 'POST', url: `${url}/api/auth/login/verify` });
      expect(click?.risk).toBe('write');
      const recipes = workflow.steps.filter((s) => s.http !== undefined);
      expect(recipes).toHaveLength(1);
      expect(JSON.stringify(workflow)).not.toMatch(/hot-update|settings\/system/);
      expect(report.filter((r) => r.level === 'http')).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
