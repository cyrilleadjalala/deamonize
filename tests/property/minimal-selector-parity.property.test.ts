// checkpoint-only: needs G-E (the HTML adapter uses the parser and resolver of src/suggest/html-zone.ts, which G-E owns)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { createMinimalSelector } from '../../src/recorder/minimal-selector.js';
import type { HtmlNode } from '../../src/suggest/html-zone.js';
import { bodyOf, htmlAdapter, parseBodyElements, runInBrowser } from '../helpers/minimal-selector-adapters.js';
import { pageDocument, renderPage, type PageDocument, type PageNode } from '../helpers/zone-arbitraries.js';

const run = createMinimalSelector<HtmlNode>();
const LIMIT = 40;

/** A browser restructures `p` with block children, `li` in `li` and `form` in `form`; these tags keep the parsed tree literal. */
const LITERAL: Record<string, string> = { p: 'div', li: 'span', form: 'section' };
const literal = (n: PageNode): PageNode => ({ ...n, tag: LITERAL[n.tag] ?? n.tag, children: n.children.map(literal) });
const literalPage = (doc: PageDocument): PageDocument => ({ root: doc.root.map(literal) });

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  page = await browser.newPage();
}, 60000);

afterAll(async () => {
  await browser?.close();
});

describe('Minimal_Selector parity', () => {
  // Feature: result-zone-selector-robustness, Property 12: One behavior in both environments
  // **Validates: Requirements 9.1, 9.6**
  it('Property 12: the browser adapter and the html-zone adapter return the same result', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pageDocument, { minLength: 3, maxLength: 6 }), async (list) => {
        const htmls = list.map((d) => renderPage(literalPage(d)));
        const browserRows = await runInBrowser(page, htmls.map(bodyOf), { includeBody: true }, LIMIT);
        htmls.forEach((html, d) => {
          const { root, elements } = parseBodyElements(html);
          const adapter = htmlAdapter(root);
          const rows = browserRows[d]!;
          expect(rows.length).toBe(Math.min(elements.length, LIMIT));
          rows.forEach((row, i) => {
            const mine = run(adapter, elements[i]!, { includeBody: false });
            expect(mine.minimal).toBe(row.result.minimal);
            expect(mine.levels).toEqual(row.result.levels);
            const expected = row.result.positional.startsWith('#') ? row.result.positional : row.result.positional.replace(/^body > /, '');
            expect(mine.positional).toBe(expected);
          });
        });
      }),
      { numRuns: 100 }
    );
  }, 180000);
});
