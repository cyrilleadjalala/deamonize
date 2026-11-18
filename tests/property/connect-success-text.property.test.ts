// Feature: kiro-thin-extension, Property 2: The success screen never prints "null" or "undefined"
// **Validates: Requirements 1.5, 1.6**
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';

vi.setConfig({ testTimeout: 180000, hookTimeout: 60000 });

const ui = resolve(import.meta.dirname, '../../src/studio/ui');
const ORIGIN = 'http://ui.test';
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };

const names = fc.array(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/), { maxLength: 3 });
const optional = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const answer = fc.record(
  {
    written: fc.array(fc.stringMatching(/^f[a-z]{0,6}\/g[a-z]{0,6}\.md$/), { maxLength: 3 }),
    placeholders: names,
    missingSecrets: names,
    requiredSecrets: names,
    autoAddSaved: fc.boolean(),
  },
  { requiredKeys: [] }
);

describe('Property 2: the success screen never prints "null" or "undefined"', () => {
  let browser: Browser;
  let page: Page;
  let install: Record<string, unknown> = {};
  let previewExtra: Record<string, unknown> = {};

  const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/harness.html') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="main" tabindex="-1"></main><div id="live" role="status"></div><script type="module" src="/harness.js"></script></body></html>' });
      }
      if (url.pathname === '/harness.js') {
        return route.fulfill({ contentType: 'text/javascript', body: "import { connectCard } from './js/views/connect.js'; document.getElementById('main').append(connectCard());" });
      }
      if (url.pathname.startsWith('/api/power/')) {
        const name = url.pathname.slice('/api/power/'.length);
        if (name === 'info') return json(route, { available: true, defaultWorkspace: '/w', outputPath: '/o', serverName: 'demo', kiroHome: '/h/.kiro', kiroHomeExists: true, installs: [] });
        if (name === 'snippet') return json(route, { snippet: '{}' });
        if (name === 'auto-add') return json(route, { enabled: false, writable: true });
        if (name === 'preview') return json(route, { confirmationId: 'id', scope: 'global', kiroPath: '/h/.kiro', files: [], replacesEntry: false, serverName: 'demo', backup: false, ...previewExtra });
        if (name === 'install') return json(route, { scope: 'global', ...install });
        return json(route, {});
      }
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

  it('renders no "null" or "undefined" word for any install answer', async () => {
    await fc.assert(
      fc.asyncProperty(answer, optional(names), fc.boolean(), async (result, previewRequired, wantsAutoAdd) => {
        install = result;
        previewExtra = previewRequired === undefined ? {} : { requiredSecrets: previewRequired };
        await page.goto('about:blank');
        await page.goto(`${ORIGIN}/harness.html`);
        await page.waitForSelector('#connect-btn');
        if (wantsAutoAdd) await page.locator('#connect-auto-add').check();
        await page.locator('#connect-btn').click();
        await page.locator('#connect-confirm').click();
        await page.waitForSelector('#connect-close');
        const text = (await page.locator('[role="dialog"] .dialog-body').textContent()) ?? '';
        expect(text).not.toMatch(/\b(null|undefined)\b/);
        // The credentials sentence agrees with the answer
        const hasPlaceholders = (result.placeholders ?? []).length > 0;
        const required = result.requiredSecrets ?? previewRequired;
        expect(text.includes('Nothing else to set up.')).toBe(!hasPlaceholders && (required?.length ?? 0) > 0);
        expect(text.includes('This tool needs no credentials.')).toBe(!hasPlaceholders && required !== undefined && required.length === 0);
      }),
      { numRuns: 100 }
    );
  });
});
