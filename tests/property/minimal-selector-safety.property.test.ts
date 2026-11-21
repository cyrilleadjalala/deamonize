import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { createMinimalSelector, isGeneratedId, isUnstableClass } from '../../src/recorder/minimal-selector.js';
import type { HtmlNode } from '../../src/suggest/html-zone.js';
import { bodyOf, htmlAdapter, parseBodyElements, runInBrowser } from '../helpers/minimal-selector-adapters.js';
import { pageDocument, renderPage } from '../helpers/zone-arbitraries.js';

const run = createMinimalSelector<HtmlNode>();
const NUM_RUNS = 100;
const MAX_ELEMENTS = 60;

/** The compounds of a selector written by the algorithm; quotes protect spaces and `>` inside a value. */
function compoundsOf(selector: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === ' ') {
      if (buf !== '') out.push(buf);
      buf = '';
    } else buf += ch;
  }
  if (buf !== '') out.push(buf);
  return out.filter((c) => c !== '>');
}

const PLAIN = '-?[A-Za-z_][A-Za-z0-9_-]*';
const COMPOUND = new RegExp(`^(?:#${PLAIN}|[a-z][a-z0-9-]*(?:\\[(?:data-testid|role)="[A-Za-z0-9 _.:/@-]{1,60}"\\]|\\.${PLAIN}|:nth-of-type\\(\\d+\\))?)$`);

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  page = await browser.newPage();
}, 60000);

afterAll(async () => {
  await browser?.close();
});

describe('Minimal_Selector safety properties', () => {
  // Feature: result-zone-selector-robustness, Property 7: No volatile source
  // **Validates: Requirements 3.4, 3.5, 4.2, 10.4, 11.4**
  it('Property 7: no generated id, unstable class or text in a selector', () => {
    fc.assert(
      fc.property(pageDocument, (doc) => {
        const { root, elements } = parseBodyElements(renderPage(doc));
        const adapter = htmlAdapter(root);
        for (const target of elements.slice(0, MAX_ELEMENTS)) {
          const result = run(adapter, target, { includeBody: false });
          for (const selector of [result.minimal, result.positional]) {
            if (selector === undefined) continue;
            expect(selector).not.toMatch(/text=|:has-text|:contains|:text/);
            for (const compound of compoundsOf(selector)) {
              if (compound === 'body') continue;
              expect(compound, selector).toMatch(COMPOUND);
              const id = /^#(.+)$/.exec(compound)?.[1];
              if (id !== undefined) expect(isGeneratedId(id)).toBe(false);
              const cls = /^[a-z][a-z0-9-]*\.(.+)$/.exec(compound)?.[1];
              if (cls !== undefined) expect(isUnstableClass(cls)).toBe(false);
            }
          }
        }
        // every unstable class and generated id of the page stays out of the selectors
        const volatileClasses = new Set<string>();
        const volatileIds = new Set<string>();
        for (const el of elements) {
          for (const c of (el.attrs['class'] ?? '').split(/\s+/)) if (c !== '' && isUnstableClass(c)) volatileClasses.add(c);
          if (el.attrs['id'] && isGeneratedId(el.attrs['id'])) volatileIds.add(el.attrs['id']);
        }
        for (const target of elements.slice(0, MAX_ELEMENTS)) {
          const r = run(adapter, target, { includeBody: false });
          for (const compound of [r.minimal, r.positional].flatMap((s) => (s === undefined ? [] : compoundsOf(s)))) {
            const id = /^#(.+)$/.exec(compound)?.[1];
            const cls = /^[a-z][a-z0-9-]*\.(.+)$/.exec(compound)?.[1];
            if (id !== undefined) expect(volatileIds.has(id)).toBe(false);
            if (cls !== undefined) expect(volatileClasses.has(cls)).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // Hostile documents: ids, classes and attribute values of arbitrary text.
  const hostileText = fc.stringMatching(/^[A-Za-z0-9 "'\[\]>\\.,:#=&<()\/@!%_-]{0,14}$/);
  interface Hostile { tag: string; id?: string; classes: string[]; testId?: string; role?: string; children: Hostile[] }
  const { node } = fc.letrec<{ node: Hostile }>((tie) => ({
    node: fc.record({
      tag: fc.constantFrom('div', 'span', 'section', 'article', 'main', 'nav', 'aside', 'header', 'footer'),
      id: fc.option(hostileText, { nil: undefined }),
      classes: fc.array(hostileText, { maxLength: 3 }),
      testId: fc.option(hostileText, { nil: undefined }),
      role: fc.option(hostileText, { nil: undefined }),
      children: fc.oneof({ arbitrary: fc.constant<Hostile[]>([]), weight: 1 }, { arbitrary: fc.array(tie('node'), { maxLength: 3 }), weight: 2 }),
    }),
  }));
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const render = (n: Hostile): string => {
    const attrs =
      (n.id !== undefined ? ` id="${esc(n.id)}"` : '') +
      (n.classes.length > 0 ? ` class="${esc(n.classes.join(' '))}"` : '') +
      (n.testId !== undefined ? ` data-testid="${esc(n.testId)}"` : '') +
      (n.role !== undefined ? ` role="${esc(n.role)}"` : '');
    return `<${n.tag}${attrs}>${n.children.map(render).join('')}</${n.tag}>`;
  };
  const hostilePage = fc.array(node, { minLength: 1, maxLength: 3 }).map((roots) => `<!doctype html><html><head><title>t</title></head><body>${roots.map(render).join('')}</body></html>`);

  // Feature: result-zone-selector-robustness, Property 8: Safe grammar
  // **Validates: Requirements 3.4, 10.4, 11.4**
  it('Property 8: every selector stays in the safe grammar and is accepted by both parsers', async () => {
    fc.assert(
      fc.property(hostilePage, (html) => {
        const { root, elements } = parseBodyElements(html);
        const adapter = htmlAdapter(root);
        for (const target of elements.slice(0, MAX_ELEMENTS)) {
          const result = run(adapter, target, { includeBody: false });
          for (const selector of [result.minimal, result.positional]) {
            if (selector === undefined || selector === '') continue;
            for (const compound of compoundsOf(selector)) expect(compound, selector).toMatch(COMPOUND);
          }
          if (result.minimal !== undefined) expect(adapter.resolve(result.minimal)).toEqual([target]);
          if (result.positional !== '') expect(adapter.resolve(result.positional)).toContain(target);
        }
      }),
      { numRuns: NUM_RUNS }
    );
    await fc.assert(
      fc.asyncProperty(fc.array(hostilePage, { minLength: 3, maxLength: 6 }), async (pages) => {
        const rows = await runInBrowser(page, pages.map(bodyOf));
        for (const doc of rows) {
          for (const row of doc) {
            expect(row.error).toBeUndefined();
            for (const selector of [row.result.minimal, row.result.positional]) {
              if (selector === undefined) continue;
              for (const compound of compoundsOf(selector)) expect(compound, selector).toMatch(COMPOUND);
            }
            if (row.result.minimal !== undefined) expect(row.uniqueMinimal).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  }, 180000);
});
