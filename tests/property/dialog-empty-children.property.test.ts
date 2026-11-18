// Feature: kiro-thin-extension, Property 1: Dialog content ignores empty children
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });

const ui = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://ui.test';
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html' };

// A child is a word (becomes a paragraph) or one of the three empty values
type Child = { text: string } | { empty: 'null' | 'undefined' | 'false' };
const child: fc.Arbitrary<Child> = fc.oneof(
  { weight: 2, arbitrary: fc.stringMatching(/^[a-z]{1,6}$/).map((text) => ({ text })) },
  { weight: 2, arbitrary: fc.constantFrom('null', 'undefined', 'false').map((empty) => ({ empty: empty as 'null' | 'undefined' | 'false' })) }
);

describe('Property 1: dialog content ignores empty children', () => {
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

  it('renders exactly the real nodes, in order, with setContent and openDialog', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(child, { maxLength: 8 }), async (children) => {
        const expected = children.filter((c): c is { text: string } => 'text' in c).map((c) => c.text);
        const out = await page.evaluate(async (list) => {
          const d = (window as any).__d;
          const h = (window as any).__h;
          const make = () => list.map((c: any) => ('text' in c ? h('p', { text: c.text }) : c.empty === 'null' ? null : c.empty === 'undefined' ? undefined : false));
          const viaSet = d.openDialog({ title: 'T', content: [] });
          viaSet.setContent(...make());
          const set = [...viaSet.body.children].map((n) => n.textContent);
          const setText = viaSet.body.textContent;
          viaSet.close();
          const viaOpen = d.openDialog({ title: 'T', content: make() });
          const open = [...viaOpen.body.children].map((n) => n.textContent);
          const openText = viaOpen.body.textContent;
          viaOpen.close();
          return { set, open, setText, openText };
        }, children);
        expect(out.set).toEqual(expected);
        expect(out.open).toEqual(expected);
        expect(out.setText).toBe(expected.join(''));
        expect(out.openText).toBe(expected.join(''));
      }),
      { numRuns: 100 }
    );
  });
});
