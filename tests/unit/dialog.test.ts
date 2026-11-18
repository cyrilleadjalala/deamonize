import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

// dialog.js in real Chromium, served from src/studio/ui under a fake origin.
const ui = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://ui.test';
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html' };

describe('dialog empty children (real Chromium)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/harness.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="main" tabindex="-1"></main><script type="module" src="/harness.js"></script></body></html>' });
      if (url.pathname === '/harness.js') return route.fulfill({ contentType: 'text/javascript', body: "import * as d from './js/dialog.js'; import { h } from './js/dom.js'; window.__d = d; window.__h = h; window.__ready = true;" });
      try {
        return await route.fulfill({ contentType: TYPES[extname(url.pathname)] ?? 'text/plain', body: await readFile(join(ui, url.pathname)) });
      } catch {
        return route.fulfill({ status: 404, body: '' });
      }
    });
    await page.goto(`${ORIGIN}/harness.html`);
    await page.waitForFunction(() => (window as any).__ready === true);
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** Runs `script` in the page with the `dialog.js` module as `d` and `h` of `dom.js`. */
  const run = <T>(script: string): Promise<T> =>
    page.evaluate(
      async (code) => {
        // eslint-disable-next-line no-new-func
        return await new Function('d', 'h', `return (async () => { ${code} })()`)((window as any).__d, (window as any).__h);
      },
      script
    ) as Promise<T>;

  it('withoutEmpty drops null, undefined and false and keeps order', async () => {
    const out = await run<string[]>(`
      const a = h('p', { text: 'a' }), b = h('p', { text: 'b' });
      return d.withoutEmpty([null, a, undefined, false, b]).map((n) => n.textContent);`);
    expect(out).toEqual(['a', 'b']);
    expect(await run<number>(`return d.withoutEmpty(null).length + d.withoutEmpty(false).length + d.withoutEmpty(undefined).length;`)).toBe(0);
  });

  it('setContent renders nodes only in order, and a mix without any empty text', async () => {
    const out = await run<{ only: string; mixed: string; count: number }>(`
      const dialog = d.openDialog({ title: 'T', content: [] });
      dialog.setContent(h('p', { text: 'one' }), h('p', { text: 'two' }));
      const only = dialog.body.textContent;
      dialog.setContent(null, h('p', { text: 'one' }), undefined, false, h('p', { text: 'two' }), null);
      const mixed = dialog.body.textContent;
      const count = dialog.body.childNodes.length;
      dialog.close();
      return { only, mixed, count };`);
    expect(out).toEqual({ only: 'onetwo', mixed: 'onetwo', count: 2 });
  });

  it('openDialog accepts scalar and array content with empty children', async () => {
    const out = await run<string[]>(`
      const texts = [];
      for (const content of [null, undefined, false, h('p', { text: 'x' }), [null, h('p', { text: 'x' }), false, undefined]]) {
        const dialog = d.openDialog({ title: 'T', content });
        texts.push(dialog.body.textContent);
        dialog.close();
      }
      return texts;`);
    expect(out).toEqual(['', '', '', 'x', 'x']);
  });
});
