import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
// @ts-expect-error no type declarations for the browser modules
import { allSecretsCopyTexts } from '../../src/studio/ui/js/copy-secrets.js';

// DOM tests of the per-application Credentials view and of the Playground auto-add line, in a real browser page that
// serves the UI modules from disk and answers the API with fixed JSON.
const uiRoot = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://studio.test';
const SECRET = 'zz-test-value-9876';
const APP = 'https://cycyly.vercel.app';
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;

let browser: Browser;
let page: Page;
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="live"></div><main id="root"></main>' });
    if (url.pathname.startsWith('/js/')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(uiRoot, url.pathname), 'utf8') });
    if (url.pathname === '/api/overview') return json({ sample: false });
    if (url.pathname === '/api/secrets' && req.method() === 'GET') {
      return json({ application: APP, secrets: [{ name: 'CRM_PASSWORD', kind: 'password', configured: false }, { name: 'CRM_TOTP', kind: 'totp', configured: true }] });
    }
    if (req.method() === 'POST') {
      posts.push({ path: url.pathname, body: JSON.parse(req.postData() ?? '{}') });
      return json({ configured: true });
    }
    return json({ error: 'not found' }, 404);
  });
  await page.goto(`${ORIGIN}/`);
}, 60000);

afterAll(async () => {
  await browser?.close();
});

describe('Credentials per application', () => {
  it('shows the host, status by name, sends application on save and forget, and never renders the value', async () => {
    await page.evaluate(async () => {
      const m = await new Function('p', 'return import(p)')('/js/views/credentials.js');
      document.getElementById('root')!.replaceChildren(await m.renderCredentials());
    });
    expect(await page.locator('#credentials-application').textContent()).toBe('These passwords are for cycyly.vercel.app');
    const row = page.locator('li[data-secret="CRM_PASSWORD"]');
    expect(await row.textContent()).toContain('has no value yet');
    expect(await page.locator('li[data-secret="CRM_TOTP"]').textContent()).toContain('has a value');

    await row.locator('input').fill(SECRET);
    await row.locator('[data-action="save"]').click();
    await expect.poll(() => row.textContent()).toContain('has a value');
    expect(posts.at(-1)).toEqual({ path: '/api/secrets', body: { name: 'CRM_PASSWORD', value: SECRET, application: APP } });
    expect(await page.content()).not.toContain(SECRET);

    await row.locator('[data-action="remove"]').click();
    await expect.poll(() => row.textContent()).toContain('has no value yet');
    expect(posts.at(-1)).toEqual({ path: '/api/secrets/forget', body: { name: 'CRM_PASSWORD', application: APP } });
    expect(await page.content()).not.toContain(SECRET);
  });
});

describe('Playground auto-add line', () => {
  const line = (status: string | undefined) =>
    page.evaluate(async (s) => {
      const m = await new Function('p', 'return import(p)')('/js/views/playground.js');
      const el = m.autoAddLine(s === undefined ? undefined : { status: s });
      return el === null ? null : el.textContent;
    }, status);

  it('shows a line for added and failed only', async () => {
    expect(await line('added')).toContain('Reload Kiro');
    expect(await line('failed')).toContain('could not be added');
    expect(await line('unchanged')).toBeNull();
    expect(await line('disabled')).toBeNull();
    expect(await line(undefined)).toBeNull();
  });
});

describe('Plain language of the new texts', () => {
  it('has none of the banned words', () => {
    expect((allSecretsCopyTexts() as string[]).filter((t) => BANNED.test(t))).toEqual([]);
  });
});
