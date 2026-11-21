import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { extractWebZone } from '../../src/replay/runtime/web-steps.js';
import { WEB_ZONE_FUNCTION, finishWebZone, notFoundMessage, zoneCandidatesOf, zoneFailure, type RawWebZone, type ZoneLike, type ZoneOutcome } from '../../src/replay/runtime/extract.js';

const firstLine = (err: unknown): string => String((err as Error)?.message ?? err).split('\n')[0];

// The previous extractWebZone (git HEAD before the candidates work), kept as the oracle.
async function previousExtractWebZone(page: Page, zone: ZoneLike, timeoutMs: number): Promise<ZoneOutcome> {
  const locator = page.locator(zone.selector ?? 'body').first();
  try {
    await locator.waitFor({ state: 'attached', timeout: Math.max(1, timeoutMs) });
  } catch {
    return zoneFailure('result_zone_not_found', notFoundMessage(zone), zone);
  }
  try {
    await page.evaluate(`window.__daemonizeZone = ${WEB_ZONE_FUNCTION}`);
    const raw = (await locator.evaluate(
      (el: Element, extractor: unknown) => (window as unknown as { __daemonizeZone(el: Element, ex: unknown): unknown }).__daemonizeZone(el, extractor),
      zone.extractor ?? { kind: 'text' },
      { timeout: Math.max(1, timeoutMs) }
    )) as RawWebZone;
    return finishWebZone(raw, zone);
  } catch (err) {
    return zoneFailure('result_extraction_failed', `The result zone could not be read: ${firstLine(err)}`, zone);
  } finally {
    await page.evaluate('delete window.__daemonizeZone').catch(() => { });
  }
}

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

const PAGE = '<table id="t"><tr><th>A</th></tr><tr><td>1</td></tr></table><ul id="l"><li>x</li><li>y</li></ul><div id="d">hello</div><dl id="f"><dt>k</dt><dd>v</dd></dl>';

describe('zone without candidates', () => {
  // Feature: result-zone-selector-robustness, Property 17: A zone without candidates behaves as before
  // **Validates: Requirements 6.8, 7.5, 11.6**
  it('Property 17: a zone without candidates behaves as before', async () => {
    await page.setContent(PAGE);
    await extractWebZone(page, { selector: '#d' }, 5000); // warm up
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('#t', '#l', '#d', '#f', '#missing', 'div[[['),
        fc.constantFrom<ZoneLike['extractor']>({ kind: 'text' }, { kind: 'table' }, { kind: 'list' }, { kind: 'fields' }, { kind: 'json' }, { kind: 'attribute' }),
        fc.boolean(),
        async (selector, extractor, withFingerprint) => {
          const zone: ZoneLike = { selector, extractor, ...(withFingerprint ? { fingerprint: { tag: 'ul', kind: 'list', count: 2 } } : {}) };
          expect(zoneCandidatesOf(zone)).toBeUndefined();
          const now = await extractWebZone(page, zone, 300);
          const before = await previousExtractWebZone(page, zone, 300);
          expect(now.ok).toBe(before.ok);
          if (now.ok && before.ok) expect(now).toEqual(before);
          if (!now.ok && !before.ok) {
            expect(now.error).toBe(before.error);
            expect(now.tried).toBeUndefined();
            if (before.error === 'result_zone_not_found') expect(now.message).toBe(before.message);
          }
        }
      ),
      { numRuns: 100 }
    );
  }, 180000);
});