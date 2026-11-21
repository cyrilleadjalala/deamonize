import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { allNodes, parseHtml, resolveSelector, suggestResultZone } from '../../src/suggest/html-zone.js';
import { pageDocument, renderPage, type PageDocument, type PageNode } from '../helpers/zone-arbitraries.js';

/** Give every document a list of two items so that a zone is suggested in most runs. */
const withList = (doc: PageDocument): PageDocument => {
  const list: PageNode = { tag: 'ul', attrs: [], children: [{ tag: 'li', attrs: [], children: [] }, { tag: 'li', attrs: [], children: [] }] };
  return { root: [...doc.root, list] };
};

describe('suggested Result_Zone candidates', () => {
  // Feature: result-zone-selector-robustness, Property 13: every suggested candidate resolves to the suggested node
  it('Property 13: every suggested candidate resolves to exactly the suggested node', () => {
    let suggested = 0;
    fc.assert(
      fc.property(pageDocument.map(withList), (doc) => {
        const html = renderPage(doc);
        const zone = suggestResultZone(html);
        if (zone === undefined) return;
        suggested += 1;
        const root = parseHtml(html);
        expect(zone.selectors).toBeDefined();
        const selectors = zone.selectors!;
        expect(selectors[0]).toBe(zone.selector);
        expect(selectors.length).toBeGreaterThan(0);
        expect(selectors.length).toBeLessThanOrEqual(5);
        expect(new Set(selectors).size).toBe(selectors.length);
        const first = resolveSelector(root, selectors[0]);
        expect(first).toHaveLength(1);
        for (const s of selectors) {
          expect(s.length).toBeLessThanOrEqual(300);
          const found = resolveSelector(root, s);
          expect(found).toHaveLength(1);
          expect(found[0]).toBe(first[0]);
        }
        expect(allNodes(root)).toContain(first[0]);
      }),
      { numRuns: 100 },
    );
    expect(suggested).toBeGreaterThan(0);
  });
});
