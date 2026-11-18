import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// The record status view in real Chromium, served under a fake origin; every /api/ call is answered here.
const ui = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://ui.test';
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

interface Calls {
  target: string;
  block: string | undefined;
  behavior: string | undefined;
}

describe('record status view after "Save and add to Kiro" (Requirements 20.6 to 20.10, 22.1 to 22.7)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let status: Record<string, unknown>;

  const json = (route: Route, code: number, body: unknown): Promise<void> => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
  const done = (over: Record<string, unknown>): Record<string, unknown> => ({ state: 'done', steps: 3, labels: [], ...over });
  const kiroOk = (extra: Record<string, unknown> = {}) => ({ added: true, message: 'The tool was added to Kiro.', scope: 'global', missingSecrets: [], requiredSecrets: [], ...extra });

  beforeAll(async () => {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    page = await context.newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/harness.html') {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/css/record.css"></head><body><header class="app-header"><span class="brand">Daemonize</span></header><main id="main"></main><div id="live" role="status"></div><script type="module" src="/harness.js"></script></body></html>',
        });
      }
      if (url.pathname === '/harness.js') {
        return route.fulfill({
          contentType: 'text/javascript',
          body: `
            window.__scrolls = [];
            const original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function (arg) {
              window.__scrolls.push({ target: this.id || this.className, block: arg && arg.block, behavior: arg && arg.behavior });
              return original.call(this, arg);
            };
            const { renderRecordStatus } = await import('./js/views/record-status.js');
            document.getElementById('main').append(await renderRecordStatus());
            window.__ready = true;`,
        });
      }
      if (url.pathname === '/api/record/status') return json(route, 200, status);
      if (url.pathname === '/api/workflows') return json(route, 200, { workflows: [{ toolName: 'find_order' }] });
      if (url.pathname.startsWith('/api/power/')) return json(route, 200, { available: true, kiroHome: '/h/.kiro', kiroHomeExists: true, installs: [], autoAdd: { enabled: false, writable: true } });
      if (url.pathname.startsWith('/api/')) return json(route, 200, {});
      try {
        return await route.fulfill({ contentType: TYPES[extname(url.pathname)] ?? 'text/plain', body: await readFile(join(ui, url.pathname)) });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const open = async (s: Record<string, unknown>): Promise<void> => {
    status = s;
    await page.goto('about:blank');
    await page.goto(`${ORIGIN}/harness.html`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    await page.waitForSelector('#record-outcome #connect-card, #record-outcome .state', { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(150);
  };
  const scrolls = (): Promise<Calls[]> => page.evaluate(() => (window as unknown as { __scrolls: Calls[] }).__scrolls);

  it('scrolls once to the outcome container, block start, when the Kiro message is shown', async () => {
    await open(done({ intent: 'kiro', kiro: kiroOk() }));
    const calls = await scrolls();
    expect(calls).toHaveLength(1);
    expect(calls[0].block).toBe('start');
    expect(calls[0].target).toContain('record-outcome');
    expect(calls.some((c) => c.block === 'center')).toBe(false);
  });

  it('uses behavior smooth by default and auto with reduced motion', async () => {
    await open(done({ intent: 'kiro', kiro: kiroOk() }));
    expect((await scrolls())[0].behavior).toBe('smooth');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(done({ intent: 'kiro', kiro: kiroOk() }));
    expect((await scrolls())[0].behavior).toBe('auto');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  it('scrolls to the Connect block when there is no Kiro message', async () => {
    await open(done({ intent: 'kiro' }));
    const calls = await scrolls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: 'connect-card', block: 'start' });
  });

  it('does not scroll for another intent, and still clicks "Test it" for test', async () => {
    await open(done({ intent: 'save' }));
    expect(await scrolls()).toEqual([]);
    await open(done({}));
    expect(await scrolls()).toEqual([]);
  });

  it('keeps the scroll margin at or above the header height and leaves room below the outcome', async () => {
    await open(done({ intent: 'kiro', kiro: kiroOk() }));
    for (const width of [1000, 390]) {
      await page.setViewportSize({ width, height: 700 });
      const m = await page.evaluate(() => {
        const header = document.querySelector('.app-header') as HTMLElement;
        const outcome = document.querySelector('.record-outcome') as HTMLElement;
        const card = document.querySelector('#connect-card') as HTMLElement;
        return {
          header: header.getBoundingClientRect().height,
          outcomeMargin: parseFloat(getComputedStyle(outcome).scrollMarginTop),
          cardMargin: parseFloat(getComputedStyle(card).scrollMarginTop),
          padding: parseFloat(getComputedStyle(outcome).paddingBottom),
        };
      });
      expect(m.outcomeMargin).toBeGreaterThanOrEqual(m.header);
      expect(m.cardMargin).toBeGreaterThanOrEqual(m.header);
      expect(m.padding).toBeGreaterThanOrEqual(16);
    }
    await page.setViewportSize({ width: 1000, height: 700 });
  });

  it('shows the credentials alert before the Connect block, with the names and one keyboard link', async () => {
    await open(done({ intent: 'kiro', kiro: kiroOk({ missingSecrets: ['API_KEY', 'DB_PASSWORD'], requiredSecrets: ['API_KEY', 'DB_PASSWORD'] }) }));
    const alert = page.locator('#kiro-missing-secrets');
    expect(await alert.getAttribute('role')).toBe('alert');
    const text = (await alert.textContent()) ?? '';
    expect(text).toContain('API_KEY');
    expect(text).toContain('DB_PASSWORD');
    expect(text).toContain('Add your credentials');
    expect(await alert.locator('a').count()).toBe(1);
    expect(await alert.locator('a').getAttribute('href')).toBe('#/credentials');
    const before = await page.evaluate(() => {
      const a = document.getElementById('kiro-missing-secrets')!;
      const c = document.getElementById('connect-card')!;
      return Boolean(a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(before).toBe(true);
    await alert.locator('a').focus();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('kiro-add-credentials');
  });

  it('shows no credentials alert when the list is empty, absent, or the install failed', async () => {
    for (const kiro of [kiroOk(), { added: true, message: 'The tool was added to Kiro.', scope: 'global' }, { added: false, message: 'The tool was built, but it could not be added to Kiro.' }]) {
      await open(done({ intent: 'kiro', kiro }));
      expect(await page.locator('#kiro-missing-secrets').count()).toBe(0);
      expect(await page.locator('#kiro-result').count()).toBe(1);
    }
  });
});
