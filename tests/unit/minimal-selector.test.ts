import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createMinimalSelector, isGeneratedId, isUnstableClass, MINIMAL_SELECTOR_SOURCE, type MinimalSelectorResult } from '../../src/recorder/minimal-selector.js';
import { looksGenerated } from '../../src/recorder/selector-builder.js';
import type { HtmlNode } from '../../src/suggest/html-zone.js';
import { htmlAdapter, parseBodyElements } from '../helpers/minimal-selector-adapters.js';
import { FAMILIES, stableClass, unstableClassByFamily } from '../helpers/zone-arbitraries.js';

const run = createMinimalSelector<HtmlNode>();

function compute(html: string, pick: (elements: HtmlNode[]) => HtmlNode): MinimalSelectorResult & { target: HtmlNode; resolve: (s: string) => HtmlNode[] } {
  const { root, elements } = parseBodyElements(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const adapter = htmlAdapter(root);
  const target = pick(elements);
  return { ...run(adapter, target, { includeBody: false }), target, resolve: adapter.resolve };
}

/** The recorded path of the introduction: body > div:nth-of-type(2) > main > div > div > div:nth-of-type(4) > div:nth-of-type(1) > div > div:nth-of-type(1) > p */
const REAL_PAGE =
  '<div><span>a</span><p>z</p></div>' +
  '<div><main><div><div>' +
  '<div>1</div><div>2</div><div>3</div>' +
  '<div><div><div><div><p>target</p></div><div>x</div></div></div><div>y</div></div>' +
  '</div></div></main></div>';

describe('Minimal_Selector algorithm', () => {
  it('does not build a selector from the ten-level real path when an anchor exists', () => {
    const r = compute(REAL_PAGE, (els) => els.filter((e) => e.tag === 'p')[1]!);
    expect(r.positional).toBe('div:nth-of-type(2) > main > div > div > div:nth-of-type(4) > div:nth-of-type(1) > div > div:nth-of-type(1) > p');
    expect(r.minimal).toBeDefined();
    expect(r.resolve(r.minimal!)).toEqual([r.target]);
    expect(r.minimal!.length).toBeLessThan(r.positional.length);
    expect(r.levels.minimal).toBeLessThan(r.levels.positional);
    expect(r.minimal).toMatch(/^main /);
  });

  it('returns the whole path when the page has no anchor and the path is the only unique form', () => {
    const html = '<div><div><span>a</span></div><div><span>b</span></div></div><div><div><span>c</span></div><div><span>d</span></div></div>';
    const r = compute(html, (els) => els.filter((e) => e.tag === 'span')[3]!);
    expect(r.minimal).toBeDefined();
    expect(r.resolve(r.minimal!)).toEqual([r.target]);
    expect(r.positional).toBe('div:nth-of-type(2) > div:nth-of-type(2) > span');
    expect(r.positional.endsWith(r.minimal!)).toBe(true);
    expect(r.levels.minimal).toBeLessThanOrEqual(r.levels.positional);
  });

  it('anchors on a stable id and prefers a unique tag over a position', () => {
    const r = compute('<div id="orders"><table><tr><td>1</td></tr></table></div><div><table></table></div>', (els) => els.find((e) => e.tag === 'td')!);
    expect(r.minimal).toBe('td');
  });

  it('uses A > T only when the descendant form is not unique', () => {
    const html = '<section class="results"><div class="row"><span class="price">1</span></div><span class="price">2</span></section>';
    const r = compute(html, (els) => els[1]!.children[0]!);
    expect(r.minimal).toBeDefined();
    expect(r.resolve(r.minimal!)).toEqual([r.target]);
    expect(r.minimal).toContain(' > ');
  });

  it('keeps a BEM class and skips a hashed class', () => {
    const stable = compute('<ul><li class="card__title">a</li><li>b</li></ul>', (els) => els[1]!);
    expect(stable.minimal).toBe('li.card__title');
    const hashed = compute('<ul><li class="css-1a2b3c">a</li><li>b</li></ul>', (els) => els[1]!);
    expect(hashed.minimal).toBeDefined();
    expect(hashed.minimal).not.toContain('css-1a2b3c');
  });

  it('never writes a hostile attribute value into the selector', () => {
    const r = compute('<div><p data-testid="a&quot;] &gt; *">x</p><p>y</p></div>', (els) => els[1]!);
    expect(r.minimal ?? '').not.toContain('data-testid');
    expect(r.positional).not.toContain('"');
    const safe = compute('<div><p data-testid="row 1:a/b@c">x</p><p>y</p></div>', (els) => els[1]!);
    expect(safe.minimal).toBe('p[data-testid="row 1:a/b@c"]');
  });

  it('drops a minimal selector longer than maxLength and keeps the positional path', () => {
    const { root, elements } = parseBodyElements('<!doctype html><html><body><div><div><span>a</span></div><div><span>b</span></div></div></body></html>');
    const target = elements.filter((e) => e.tag === 'span')[1]!;
    const r = run(htmlAdapter(root), target, { includeBody: false, maxLength: 5 });
    expect(r.minimal).toBeUndefined();
    expect(r.positional).toBe('div > div:nth-of-type(2) > span');
  });

  it('is deterministic', () => {
    const a = compute(REAL_PAGE, (els) => els.filter((e) => e.tag === 'p')[1]!);
    const b = compute(REAL_PAGE, (els) => els.filter((e) => e.tag === 'p')[1]!);
    expect(a.minimal).toBe(b.minimal);
    expect(a.levels).toEqual(b.levels);
  });
});

describe('unstable classes', () => {
  for (const family of FAMILIES) {
    it(`family ${family} is rejected`, () => {
      for (const name of fc.sample(unstableClassByFamily[family]!, 25)) expect(isUnstableClass(name), name).toBe(true);
    });
  }

  it('keeps BEM and plain words', () => {
    for (const name of ['card__title', 'result-table', 'orders', 'price', 'main-content', 'card__title--wide']) expect(isUnstableClass(name), name).toBe(false);
    for (const name of fc.sample(stableClass, 25)) {
      if (isUnstableClass(name)) expect(/[0-9a-f]{8,}|\d{4,}|[-_](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,8}$|^(m|p|w|h|gap|text|bg|border|rounded|col|z|top|row|min|max|font|items|order|self|left|right|bottom|space|flex|grid|opacity|shadow|leading|tracking|justify|overflow)[xytblrse]?-/.test(name), name).toBe(true);
    }
  });
});

describe('drift guard', () => {
  it('isGeneratedId equals looksGenerated', () => {
    const fixed = ['deadbeef', '12345', ':r1:', '_R_abc_-field', '\u00abr2\u00bb', 'radix-x1', 'orders', 'result-table', 'abc', '1a2b3c4d5e', 'main', ':R2a:'];
    for (const id of fixed) expect(isGeneratedId(id), id).toBe(looksGenerated(id));
    fc.assert(fc.property(fc.string({ maxLength: 20 }), (s) => isGeneratedId(s) === looksGenerated(s)), { numRuns: 300 });
    fc.assert(fc.property(fc.stringMatching(/^[0-9a-f:_rR\u00ab\u00bbxradi-]{0,16}$/), (s) => isGeneratedId(s) === looksGenerated(s)), { numRuns: 300 });
  });
});

describe('source text', () => {
  it('has no backtick and no dollar-brace', () => {
    expect(MINIMAL_SELECTOR_SOURCE).not.toContain('`');
    expect(MINIMAL_SELECTOR_SOURCE).not.toContain('${');
  });
});
