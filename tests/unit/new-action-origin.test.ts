import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// The new-action form in real Chromium, served under a fake origin; every /api/ call is answered here.
const ui = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://ui.test';
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
const EXPECTED = 'This folder already holds actions for https://shop.test. Another application needs another folder.';

describe('new action form: another application (Requirements 12.6, 12.7, 12.8)', () => {
  let browser: Browser;
  let page: Page;
  let overview: unknown;
  const starts: unknown[] = [];

  const json = (route: Route, status: number, body: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/harness.html') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="main"></main><div id="live" role="status"></div><script type="module" src="/harness.js"></script></body></html>' });
      }
      if (url.pathname === '/harness.js') {
        return route.fulfill({ contentType: 'text/javascript', body: "import { newActionSection } from './js/views/new-action.js'; document.getElementById('main').append(newActionSection());" });
      }
      if (url.pathname === '/api/overview') return json(route, 200, overview);
      if (url.pathname === '/api/record/start') {
        starts.push(JSON.parse(route.request().postData() ?? '{}'));
        return json(route, 202, { state: 'recording' });
      }
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

  const open = async (over: unknown = { targets: [{ type: 'web', start: 'https://shop.test/login', workflows: 2 }] }): Promise<void> => {
    overview = over;
    starts.length = 0;
    await page.goto('about:blank');
    await page.goto(`${ORIGIN}/harness.html`);
    await page.click('#new-action-btn');
    await page.waitForSelector('#action-url');
    await page.waitForTimeout(100);
  };
  const type = async (value: string): Promise<void> => {
    await page.fill('#action-url', value);
  };

  it('shows the message within 300 ms of the last keystroke, disables the button, and links it to the field', async () => {
    await open();
    await type('https://other.test/start');
    await page.waitForSelector('#action-url-origin', { timeout: 600 });
    const note = page.locator('#action-url-origin');
    expect(await note.getAttribute('role')).toBe('alert');
    expect((await note.textContent())?.trim()).toBe(EXPECTED);
    expect(await page.getAttribute('#action-url', 'aria-describedby')).toContain('action-url-origin');
    expect(await page.isDisabled('#start-recording')).toBe(true);
  });

  it('does not show it before the quiet period of 300 ms', async () => {
    await open();
    await type('https://other.test/start');
    expect(await page.locator('#action-url-origin').count()).toBe(0);
  });

  it('removes the message and enables the button for the same origin, an empty or an invalid address', async () => {
    await open();
    await type('https://other.test/');
    await page.waitForSelector('#action-url-origin');
    for (const value of ['https://shop.test:443/other?x=1#y', '', 'not a url']) {
      await type('https://other.test/');
      await page.waitForSelector('#action-url-origin');
      await type(value);
      await page.waitForSelector('#action-url-origin', { state: 'detached', timeout: 1000 });
      expect(await page.isDisabled('#start-recording')).toBe(false);
      expect(await page.getAttribute('#action-url', 'aria-describedby')).not.toContain('action-url-origin');
    }
  });

  it('shows nothing when the file holds no workflow, or holds a terminal target', async () => {
    for (const over of [
      { targets: [{ type: 'web', start: 'https://shop.test/', workflows: 0 }] },
      { targets: [{ type: 'tui', start: 'app (+1 argument)', workflows: 3 }] },
      { targets: [] },
    ]) {
      await open(over);
      await type('https://other.test/');
      await page.waitForTimeout(450);
      expect(await page.locator('#action-url-origin').count()).toBe(0);
      expect(await page.isDisabled('#start-recording')).toBe(false);
    }
  });

  it('sends no request while the message is shown', async () => {
    await open();
    await page.fill('#action-name', 'Find order');
    await type('https://other.test/');
    await page.waitForSelector('#action-url-origin');
    await page.locator('#new-action-form').evaluate((f) => (f as HTMLFormElement).requestSubmit());
    await page.waitForTimeout(200);
    expect(starts).toEqual([]);
  });
});
