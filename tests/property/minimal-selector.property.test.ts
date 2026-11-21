import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { createMinimalSelector } from '../../src/recorder/minimal-selector.js';
import type { HtmlNode } from '../../src/suggest/html-zone.js';
import { bodyOf, htmlAdapter, parseBodyElements, runInBrowser } from '../helpers/minimal-selector-adapters.js';
import { pageDocument, renderPage } from '../helpers/zone-arbitraries.js';

const run = createMinimalSelector<HtmlNode>();
const NUM_RUNS = 100;
const MAX_ELEMENTS = 60;

function htmlResults(html: string) {
  const { root, elements } = parseBodyElements(html);
  const adapter = htmlAdapter(root);
  return elements.slice(0, MAX_ELEMENTS).map((target) => ({ target, adapter, result: run(adapter, target, { includeBody: false }) }));
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  page = await browser.newPage();
}, 60000);

afterAll(async () => {
  await browser?.close();
});

const docs = fc.array(pageDocument, { minLength: 3, maxLength: 6 });

describe('Minimal_Selector properties', () => {
  // Feature: result-zone-selector-robustness, Property 4: Minimal selector is unique
  // **Validates: Requirements 3.1, 3.8, 11.1**
  it('Property 4: minimal selector is unique (HTML adapter)', () => {
    fc.assert(
      fc.property(pageDocument, (doc) => {
        for (const { target, adapter, result } of htmlResults(renderPage(doc))) {
          if (result.minimal !== undefined) expect(adapter.resolve(result.minimal)).toEqual([target]);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Feature: result-zone-selector-robustness, Property 4: Minimal selector is unique
  // **Validates: Requirements 3.1, 3.8, 11.1**
  it('Property 4: minimal selector is unique (browser adapter)', async () => {
    await fc.assert(
      fc.asyncProperty(docs, async (list) => {
        const rows = await runInBrowser(page, list.map((d) => bodyOf(renderPage(d))));
        for (const doc of rows) {
          for (const row of doc) {
            expect(row.error).toBeUndefined();
            if (row.result.minimal !== undefined) expect(row.uniqueMinimal).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  }, 180000);

  // Feature: result-zone-selector-robustness, Property 5: Minimal selector uses no more levels than the positional path
  // **Validates: Requirements 3.7, 3.11, 11.2**
  it('Property 5: minimal uses no more levels than the positional path (both adapters)', async () => {
    fc.assert(
      fc.property(pageDocument, (doc) => {
        for (const { result } of htmlResults(renderPage(doc))) {
          expect(result.levels.minimal).toBeLessThanOrEqual(result.levels.positional);
          expect((result.minimal ?? '').length).toBeLessThanOrEqual(300);
        }
      }),
      { numRuns: NUM_RUNS }
    );
    await fc.assert(
      fc.asyncProperty(docs, async (list) => {
        const rows = await runInBrowser(page, list.map((d) => bodyOf(renderPage(d))));
        for (const doc of rows) {
          for (const row of doc) {
            expect(row.result.levels.minimal).toBeLessThanOrEqual(row.result.levels.positional);
            expect((row.result.minimal ?? '').length).toBeLessThanOrEqual(300);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  }, 180000);

  // Feature: result-zone-selector-robustness, Property 6: Idempotence
  // **Validates: Requirements 3.9, 11.3**
  it('Property 6: idempotence (both adapters)', async () => {
    fc.assert(
      fc.property(pageDocument, (doc) => {
        const html = renderPage(doc);
        const { root, elements } = parseBodyElements(html);
        const adapter = htmlAdapter(root);
        for (const target of elements.slice(0, MAX_ELEMENTS)) {
          expect(run(adapter, target, { includeBody: false })).toEqual(run(adapter, target, { includeBody: false }));
        }
      }),
      { numRuns: NUM_RUNS }
    );
    await fc.assert(
      fc.asyncProperty(docs, async (list) => {
        const rows = await runInBrowser(page, list.map((d) => bodyOf(renderPage(d))));
        for (const doc of rows) for (const row of doc) expect(row.again).toEqual(row.result);
      }),
      { numRuns: NUM_RUNS }
    );
  }, 180000);
});
