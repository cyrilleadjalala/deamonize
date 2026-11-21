import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { sampleApprovals, sampleAuditEntries } from '../../src/studio/sample-activity.js';
import { removeDir } from '../helpers/cleanup.js';

// The Activity view and the approval banner against a live Studio. The two feature routes are answered by Playwright
// interception with the fictitious samples, so the file does not depend on the other groups' routes.

const json = (route: Route, status: number, body: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

describe('Studio Activity view and approval banner (real Chromium)', () => {
  let dir: string;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;
  let base: string;
  let entries = sampleAuditEntries();
  let pending = sampleApprovals();
  const decides: unknown[] = [];

  const open = async (hash: string): Promise<void> => {
    await page.goto('about:blank');
    await page.goto(`${base}/${hash}`);
    await page.waitForSelector('main h1', { state: 'visible' });
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-ui-activity-'));
    studio = await startStudio({ workflowFile: join(dir, 'missing.json'), outDir: join(dir, 'out'), env: {} });
    base = studio.url.replace(/\/\?token=.*$/, '');
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.route('**/api/activity**', (route) => {
      const url = new URL(route.request().url());
      const tool = url.searchParams.get('tool');
      const decision = url.searchParams.get('decision');
      const list = entries.filter((e) => (tool === null || e.tool === tool) && (decision === null || e.decision === decision));
      return json(route, 200, { entries: list, tools: [...new Set(entries.map((e) => e.tool))], total: list.length });
    });
    await page.route('**/api/approvals', (route) => json(route, 200, { pending, serverTime: new Date().toISOString() }));
    await page.route('**/api/approvals/decide', (route) => {
      decides.push(JSON.parse(route.request().postData() ?? '{}'));
      pending = [];
      return json(route, 200, { id: sampleApprovals()[0].id, decision: 'approved' });
    });
    await page.goto(studio.url);
    await page.waitForSelector('main h1');
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (dir) await removeDir(dir);
  });

  it('lists the calls with words for every decision and offers no edit or delete control', async () => {
    await open('#/activity');
    await expect.poll(() => page.locator('tr.activity-row').count()).toBe(entries.length);
    const text = (await page.locator('.activity-table').textContent()) ?? '';
    for (const word of ['You approved', 'You denied', 'No answer in time', 'Could not ask you', 'Ran without asking', 'Worked']) expect(text).toContain(word);
    expect(await page.getByRole('button', { name: /^(delete|edit|remove|clear)/i }).count()).toBe(0);
    // The only buttons of the table are the expanders
    expect(await page.locator('.activity-table button:not([aria-expanded])').count()).toBe(0);
  });

  it('expands a row to show the redacted arguments and the simplified steps', async () => {
    await open('#/activity');
    const first = page.locator('.activity-table button[aria-expanded]').first();
    await first.waitFor();
    expect(await first.getAttribute('aria-expanded')).toBe('false');
    await first.click();
    expect(await first.getAttribute('aria-expanded')).toBe('true');
    const details = page.locator('tr.activity-details:not([hidden])');
    expect(await details.count()).toBe(1);
    const text = (await details.textContent()) ?? '';
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('***');
    expect(await details.locator('ol.timeline').count()).toBe(1);
  });

  it('keeps the filters in the address and shows the empty filter result', async () => {
    await open('#/activity');
    await page.locator('#activity-filter-decision').selectOption('denied');
    await expect.poll(() => page.url()).toContain('decision=denied');
    await expect.poll(() => page.locator('tr.activity-row').count()).toBe(1);
    await open('#/activity?tool=list_invoices&decision=denied');
    await expect.poll(() => page.locator('main .notice').first().textContent()).toContain('No call matches these filters.');
    expect(await page.locator('.activity-table').count()).toBe(0);
  });

  it('shows the empty state and no table when there is no call', async () => {
    const saved = entries;
    entries = [];
    try {
      await open('#/activity');
      await expect.poll(() => page.locator('main').textContent()).toContain('No calls yet. When Kiro uses one of your tools, it appears here.');
      expect(await page.locator('table').count()).toBe(0);
    } finally {
      entries = saved;
    }
  });

  it('shows a pending question as an alert, keeps the focus, and sends the answer', async () => {
    pending = sampleApprovals();
    await open('#/activity');
    const alert = page.locator('section.approval-request[role="alert"]');
    await alert.waitFor();
    const text = (await alert.textContent()) ?? '';
    for (const word of ['create_invoice', 'Changes data', 'Ada Lovelace', '***', 'Click Create invoice', 'Seconds left']) expect(text).toContain(word);
    // The focus did not move to a button
    expect(await page.evaluate(() => document.activeElement?.closest('.approval-request') ?? null)).toBeNull();
    // Tab order: Approve, then Deny
    const names = await alert.getByRole('button').evaluateAll((els) => els.map((el) => el.textContent));
    expect(names).toEqual(['Approve', 'Deny']);
    await expect.poll(() => page.locator('#live').textContent()).toContain('Kiro asks to use create_invoice');
    await alert.getByRole('button', { name: 'Approve: create_invoice' }).click();
    await expect.poll(() => decides.length).toBe(1);
    expect(decides[0]).toEqual({ id: '0123456789abcdef0123456789abcdef', decision: 'approved' });
    await expect.poll(() => page.locator('section.approval-request').count()).toBe(0);
  });
});
