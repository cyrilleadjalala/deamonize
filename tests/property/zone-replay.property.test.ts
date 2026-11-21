import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { extractWebZone } from '../../src/replay/runtime/web-steps.js';
import { judgeCandidate, type RawWebZone, type ZoneLike } from '../../src/replay/runtime/extract.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  page = await browser.newPage();
  await page.setContent('<ul id="w"><li>w</li></ul>');
  await extractWebZone(page, { selector: '#w', extractor: { kind: 'list' } }, 5000); // warm up the page and the reader
});
afterAll(async () => {
  await browser?.close();
});

type Reading = 'missing' | 'wrongTag' | 'unreadable' | 'empty' | 'full';
const reading = fc.constantFrom<Reading>('missing', 'wrongTag', 'unreadable', 'empty', 'full');
const verdictOf = (r: Reading): 'accepted' | 'soft' | 'rejected' => (r === 'full' ? 'accepted' : r === 'empty' ? 'soft' : 'rejected');

const htmlOf = (r: Reading, i: number): string => {
  switch (r) {
    case 'missing': return '';
    case 'wrongTag': return `<ol id="c${i}"><li>x</li></ol>`;
    case 'unreadable': return `<div id="c${i}">plain</div>`;
    case 'empty': return `<ul id="c${i}"></ul>`;
    case 'full': return `<ul id="c${i}"><li>item${i}</li></ul>`;
  }
};

describe('zone replay properties', () => {
  // Feature: result-zone-selector-robustness, Property 14: First accepted candidate wins
  // **Validates: Requirements 6.1, 6.2, 6.6, 6.7, 6.9**
  it('Property 14: first accepted candidate wins', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(reading, { minLength: 1, maxLength: 6 }), async (readings) => {
        await page.setContent(readings.map(htmlOf).join(''));
        const selectors = readings.map((_, i) => `#c${i}`);
        const zone: ZoneLike = { selector: selectors[0], selectors, extractor: { kind: 'list' }, fingerprint: { tag: 'ul', kind: 'list', count: 3 } };
        const out = await extractWebZone(page, zone, 1500); // generous per-candidate budget so a loaded machine cannot starve an element that exists
        const accepted = readings.findIndex((r) => verdictOf(r) === 'accepted');
        const soft = readings.findIndex((r) => verdictOf(r) === 'soft');
        const expected = accepted >= 0 ? accepted : soft;
        if (expected < 0) {
          expect(out.ok).toBe(false);
          if (!out.ok) {
            expect(out.error).toBe('result_zone_not_found');
            expect(out.tried).toBe(readings.length);
          }
          return;
        }
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.data).toEqual(readings[expected] === 'full' ? [`item${expected}`] : []);
        if (expected === 0) expect(out.fallback).toBeUndefined();
        else expect(out.fallback).toEqual({ position: expected + 1, of: readings.length });
      }),
      { numRuns: 100 }
    );
  }, 180000);

  // Feature: result-zone-selector-robustness, Property 15: Fingerprint rule
  // **Validates: Requirements 6.3, 6.4**
  it('Property 15: fingerprint rule', () => {
    const rawArb = fc.record({
      text: fc.constant('t'),
      items: fc.array(fc.constantFrom('', ' ', 'a', 'b c'), { maxLength: 4 }),
    });
    fc.assert(
      fc.property(
        rawArb,
        fc.constantFrom('ul', 'ol', 'div'),
        fc.constantFrom('ul', 'ol', 'div'),
        fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
        fc.constantFrom('list', 'text', 'table'),
        (raw: RawWebZone, elementTag, fpTag, count, fpKind) => {
          const zone: ZoneLike = { extractor: { kind: 'list' }, fingerprint: { tag: fpTag, kind: fpKind, ...(count === undefined ? {} : { count }) } };
          const { verdict } = judgeCandidate(raw, elementTag, zone);
          const current = raw.items!.filter((s) => s.trim() !== '').length;
          if (elementTag !== fpTag) expect(verdict).toBe('rejected');
          else if (count !== undefined && fpKind === 'list' && current === 0) expect(verdict).toBe('soft');
          else expect(verdict).toBe('accepted');
        }
      ),
      { numRuns: 200 }
    );
  });
});