import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { extractWebZone } from '../../src/replay/runtime/web-steps.js';
import { zoneFailureResult, type ZoneLike } from '../../src/replay/runtime/extract.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  page = await browser.newPage();
});
afterAll(async () => {
  await browser?.close();
});

const LIST_PAGE = '<ul id="results"><li>alpha</li><li>beta</li></ul>';

describe('replay of a zone with candidates', () => {
  it('uses the second candidate when the first is gone and reports its position', async () => {
    await page.setContent(LIST_PAGE);
    const zone: ZoneLike = { selector: '#gone', selectors: ['#gone', '#results'], extractor: { kind: 'list' }, fingerprint: { tag: 'ul', kind: 'list', count: 2 } };
    const out = await extractWebZone(page, zone, 400);
    expect(out).toMatchObject({ ok: true, data: ['alpha', 'beta'], fallback: { position: 2, of: 2 } });
  });

  it('reports candidatesTried and no page text when nothing matches', async () => {
    await page.setContent('<p>SECRET-PAGE-TEXT</p>');
    const zone: ZoneLike = { selector: '#a', selectors: ['#a', '#b', '#c'], extractor: { kind: 'list' } };
    const out = await extractWebZone(page, zone, 300);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('result_zone_not_found');
    expect(out.tried).toBe(3);
    expect(out.message).toContain('3 ways');
    expect(out.message).not.toContain('SECRET-PAGE-TEXT');
    expect(zoneFailureResult(out, 5).failure.candidatesTried).toBe(3);
  });

  it('accepts a header-only table from the primary candidate without a fallback', async () => {
    await page.setContent('<table id="t"><tr><th>Name</th><th>Qty</th></tr></table><table id="u"><tr><th>x</th></tr><tr><td>1</td></tr></table>');
    const zone: ZoneLike = { selector: '#t', selectors: ['#t', '#u'], extractor: { kind: 'table' }, fingerprint: { tag: 'table', kind: 'table', count: 3 } };
    const out = await extractWebZone(page, zone, 400);
    expect(out).toMatchObject({ ok: true, data: [] });
    expect(out.ok && out.fallback).toBeFalsy();
  });

  it('moves on from a candidate that cannot be read, to a good one', async () => {
    await page.setContent(`<div id="d">no list here</div>${LIST_PAGE}`);
    const zone: ZoneLike = { selector: '#d', selectors: ['#d', '#results'], extractor: { kind: 'list' } };
    const out = await extractWebZone(page, zone, 400);
    expect(out).toMatchObject({ ok: true, data: ['alpha', 'beta'], fallback: { position: 2, of: 2 } });
  });

  it('rejects a hand-edited invalid selector for that candidate only', async () => {
    await page.setContent(LIST_PAGE);
    const zone: ZoneLike = { selector: '#results', selectors: ['#results', 'div[[['], extractor: { kind: 'list' } };
    expect(await extractWebZone(page, { ...zone, selector: 'div[[[' }, 400)).toMatchObject({ ok: true, fallback: { position: 2, of: 2 } });
    expect(await extractWebZone(page, zone, 400)).toMatchObject({ ok: true, data: ['alpha', 'beta'] });
  });

  it('keeps the soft empty reading when nothing better exists', async () => {
    await page.setContent('<ul id="e"></ul>');
    const zone: ZoneLike = { selector: '#e', selectors: ['#e', '#none'], extractor: { kind: 'list' }, fingerprint: { tag: 'ul', kind: 'list', count: 4 } };
    expect(await extractWebZone(page, zone, 300)).toMatchObject({ ok: true, data: [] });
  });
});