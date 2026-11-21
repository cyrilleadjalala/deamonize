// checkpoint-only: needs G-U1 (the Activity view test below uses the Activity view)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { sampleAuditEntries, sampleTrace } from '../../src/studio/sample-activity.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });
const json = (route: Route, status: number, body: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// The replay timeline in the Playground and the simplified one in the Activity view, against a live sample Studio.
describe('Studio replay timeline (real Chromium)', () => {
  let dir: string;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;
  let base: string;
  let withTrace = true;
  const trace = sampleTrace();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-ui-timeline-'));
    studio = await startStudio({ sampleData: true, workflowFile: join(dir, 'missing.json'), outDir: join(dir, 'out'), env: {} });
    base = studio.url.replace(/\/\?token=.*$/, '');
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.route('**/api/playground/call', (route) =>
      json(route, 200, { ok: true, tool: 'search_customers', elapsedMs: 3000, success: false, drifted: true, error: 'step_failed', ...(withTrace ? { trace } : {}) })
    );
    await page.route('**/api/activity**', (route) => json(route, 200, { entries: sampleAuditEntries(), tools: ['create_invoice'], total: sampleAuditEntries().length }));
    await page.route('**/api/approvals', (route) => json(route, 200, { pending: [], serverTime: new Date().toISOString() }));
    await page.goto(studio.url);
    await page.waitForSelector('main h1');
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (dir) await removeDir(dir);
  });

  const call = async (): Promise<void> => {
    await page.goto('about:blank');
    await page.goto(`${base}/#/playground?tool=search_customers`);
    await page.waitForSelector('#pg-call');
    await page.fill('input[type="text"]:not(.pg-timeout)', 'ada');
    await page.click('#pg-call');
    await page.waitForSelector('.pg-result');
  };

  it('shows one row per step, in order, with level, status and the notes of the sample trace', async () => {
    withTrace = true;
    await call();
    const list = page.locator('ol[aria-label="Replay timeline"]');
    expect(await list.count()).toBe(1);
    const rows = list.locator('> li');
    expect(await rows.count()).toBe(trace.length);
    const texts = await rows.allTextContents();
    trace.forEach((step, i) => {
      expect(texts[i]).toContain(`Step ${step.index + 1}`);
      expect(texts[i]).toContain(step.label);
    });
    const all = texts.join('\n');
    expect(all).toContain('Skipped (optional value left out)');
    expect(all).toContain('Drifted');
    expect(all).toContain('Blocked: not run again');
    expect(all).toContain('Not repeated: this step changes data');
    expect(all).toContain('Not run');
  });

  it('shows no timeline when the result has no trace', async () => {
    withTrace = false;
    await call();
    expect(await page.locator('ol[aria-label="Replay timeline"]').count()).toBe(0);
    expect(await page.locator('.pg-result').count()).toBe(1);
  });

  it('shows the simplified timeline in the Activity view, without pictures', async () => {
    await page.goto('about:blank');
    await page.goto(`${base}/#/activity`);
    await page.locator('.activity-table button[aria-expanded]').first().waitFor();
    await page.locator('.activity-table button[aria-expanded]').first().click();
    const details = page.locator('tr.activity-details:not([hidden])');
    const list = details.locator('ol.timeline');
    expect(await list.count()).toBe(1);
    expect(await list.locator('> li').count()).toBeGreaterThan(0);
    expect(await list.locator('img').count()).toBe(0);
  });
});
