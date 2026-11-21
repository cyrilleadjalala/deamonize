import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

const WIKI_LIKE_PAGE = `<!doctype html>
<html>
<head>
  <title>Search results</title>
  <style>
    body { margin: 80px 24px 24px; font-family: system-ui, sans-serif; }
    main { max-width: 720px; padding: 12px; }
    section { padding: 10px; border: 1px solid #ddd; }
    ul { padding: 8px 16px; margin: 8px 0; }
    li { margin: 6px 0; }
    table { border-collapse: collapse; margin-top: 16px; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
  </style>
</head>
<body>
  <main id="content">
    <h1>Results for query</h1>
    <section id="results-section">
      <h2>Top matches</h2>
      <ul id="wiki-results">
        <li><a href="#a">Ada Lovelace</a> — pioneer of computing</li>
        <li><a href="#b">Alan Turing</a> — computer scientist</li>
        <li><a href="#c">Grace Hopper</a> — compiler designer</li>
        <li><a href="#d">Charles Babbage</a> — analytical engine</li>
      </ul>
    </section>
    <table id="stats-table">
      <thead><tr><th>Language</th><th>Year</th></tr></thead>
      <tbody>
        <tr><td>Pascal</td><td>1970</td></tr>
        <tr><td>TypeScript</td><td>2012</td></tr>
      </tbody>
    </table>
    <dl id="meta-dl"><dt>Status</dt><dd>Published</dd></dl>
    <pre id="json-pre">{"count":4,"source":"wiki"}</pre>
    <input id="filter-input" type="text" value="Ada" />
  </main>
</body>
</html>`;

describe('interactive result zone picking, live preview, resizing and clear', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(WIKI_LIKE_PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => httpServer?.close(() => done()));
  });

  async function attach(studio = false): Promise<{ live: LiveRecorder; recorder: WorkflowRecorder }> {
    const recorder = new WorkflowRecorder('InteractiveZone');
    const live = new LiveRecorder(page, recorder, { studio });
    await page.goto(baseUrl);
    await live.attach();
    return { live, recorder };
  }

  const panelText = async (): Promise<string> => (await page.locator('[data-daemonize-panel]').textContent().catch(() => '')) ?? '';

  it('shows item sub-highlights and live item count on hover, then climbs wider/narrower via Arrow keys and Enter', async () => {
    const { live } = await attach();

    expect(await panelText()).toContain('Optional');
    await page.locator('[data-daemonize-action=mark-result]').click();
    await page.locator('[data-daemonize-action=mark-panel-box]').waitFor();

    // Hovering an <li> snaps to #wiki-results, shows item count + snippet + item boxes
    await page.locator('#wiki-results li').first().hover();
    await expect.poll(() => page.locator('[data-daemonize-action=mark-info]').textContent()).toContain('ul#wiki-results · list · 4 items');
    const tipText = await page.locator('[data-daemonize-ui]').evaluate(() => {
      const ui = document.querySelector('[data-daemonize-ui]')!;
      return ui.innerText;
    });
    expect(tipText).toContain('Ada Lovelace');

    // Expand up from ul#wiki-results -> section#results-section -> main#content, then step back down with ArrowDown
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => page.locator('[data-daemonize-action=mark-info]').textContent()).toContain('section#results-section');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.locator('[data-daemonize-action=mark-info]').textContent()).toContain('ul#wiki-results · list · 4 items');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => page.locator('[data-daemonize-action=mark-info]').textContent()).toContain('section#results-section');

    // Confirm with Enter selects the widened section
    await page.keyboard.press('Enter');
    await expect.poll(() => live.resultZone?.selector).toBe('#results-section');
    await page.locator('[data-daemonize-action=result-preview]').waitFor();
    expect(await page.locator('[data-daemonize-action=result-preview]').innerText()).toContain('Top matches');
  });

  it('tunes container with post-click Wider/Narrower, updates live preview per format tab, flashes on hover, and clears to full page', async () => {
    const { live } = await attach(true);

    await page.locator('[data-daemonize-action=mark-result]').click();
    await page.locator('#wiki-results li').first().hover();
    await page.locator('#wiki-results li').first().click();

    await page.locator('[data-daemonize-action=result-preview]').waitFor();
    expect(live.resultZone).toMatchObject({ selector: '#wiki-results', extractor: { kind: 'list' } });
    expect(live.resultZone?.selectors?.[0]).toBe(live.resultZone?.selector);
    expect(await page.locator('[data-daemonize-action=result-preview]').innerText()).toContain('4 items');
    expect(await page.locator('[data-daemonize-action=result-preview]').innerText()).toContain('Ada Lovelace');

    // Switching to incompatible format ("table") warns immediately in live preview
    await page.locator('[data-daemonize-action=result-kind-table]').click();
    await expect.poll(() => page.locator('[data-daemonize-action=result-preview]').innerText()).toContain('no table here');

    // Switching back to "list", then widening to section#results-section and narrowing back down to one <li>
    await page.locator('[data-daemonize-action=result-wider]').click();
    await expect.poll(() => live.resultZone?.selector).toBe('#results-section');
    await page.locator('[data-daemonize-action=result-narrower]').click();
    await expect.poll(() => live.resultZone?.selector).toBe('#wiki-results');
    await page.locator('[data-daemonize-action=result-narrower]').click();
    await expect.poll(() => page.locator('[data-daemonize-action=result-card]').innerText()).toContain('li');

    // Hovering the result card illuminates the page highlight; leaving hides it
    await page.locator('[data-daemonize-action=result-card]').hover();
    await expect.poll(() => page.locator('[data-daemonize-ui] div[style*="pointer-events: none"]').first().isVisible()).toBe(true);
    await page.locator('h1').hover();
    await expect.poll(() => page.locator('[data-daemonize-ui] div[style*="pointer-events: none"]').first().isVisible()).toBe(false);

    // Clear resets back to whole-page capture, and End Sheet reflects that too
    await page.locator('[data-daemonize-action=clear-result]').click();
    await expect.poll(() => live.resultZone).toBeUndefined();

    // Also test clearing from the End Sheet itself
    await page.locator('[data-daemonize-action=mark-result]').click();
    await page.locator('#stats-table td').first().click();
    await expect.poll(() => live.resultZone?.selector).toBe('#stats-table');

    await page.getByRole('button', { name: 'Finish and save' }).click();
    await expect.poll(() => page.locator('[data-daemonize-action=finish-sheet]').isVisible()).toBe(true);
    await expect.poll(() => page.locator('[data-daemonize-action=sheet-facts]').innerText()).toContain('Result: table');

    await page.locator('[data-daemonize-action=sheet-clear-result]').click();
    await expect.poll(() => live.resultZone).toBeUndefined();
    await expect.poll(() => page.locator('[data-daemonize-action=sheet-facts]').innerText()).toContain('Result: full page');
  });

  it('analyzes table, fields, json, attribute and text zones accurately', async () => {
    await attach();
    const analyses = await page.evaluate(() => {
      const h = (window as any).__daemonizeHelpers;
      return {
        table: h.analyzeZone(document.getElementById('stats-table'), 'table'),
        fields: h.analyzeZone(document.getElementById('meta-dl'), 'fields'),
        json: h.analyzeZone(document.getElementById('json-pre'), 'json'),
        attribute: h.analyzeZone(document.getElementById('filter-input'), 'attribute'),
        text: h.analyzeZone(document.querySelector('h1'), 'text'),
      };
    });
    expect(analyses.table).toMatchObject({ ok: true, badge: '3 rows × 2 cols' });
    expect(analyses.fields).toMatchObject({ ok: true, badge: '1 field' });
    expect(analyses.json).toMatchObject({ ok: true, badge: 'JSON (2 keys)' });
    expect(analyses.attribute).toMatchObject({ ok: true, lines: ['Ada'] });
    expect(analyses.text).toMatchObject({ ok: true, lines: ['Results for query'] });
  });
});
