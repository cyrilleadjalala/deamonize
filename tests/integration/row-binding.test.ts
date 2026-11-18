import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { resolveRowStep } from '../../src/replay/runtime/row-resolver.js';
import type { WorkflowStep } from '../../src/types.js';

const FIXTURES = new URL('../fixtures/web/', import.meta.url);

describe('relational locators for dynamic lists and tables', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      const name = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1);
      const file = new URL(name, FIXTURES);
      if (!/^[a-z-]+\.html$/.test(name) || !existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(readFileSync(file));
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/dynamic-table.html`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined,
    });
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    httpServer?.closeAllConnections();
    await new Promise<void>((done) => httpServer?.close(() => done()));
  }, 30000);

  const nameCell = (table: string, name: string) =>
    page.locator(`${table} tr`).filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${name}$`) }) });

  /** Record "search for Ada (variable), then Delete the Ada row". */
  async function recordDeleteAda(): Promise<{ recorder: WorkflowRecorder; live: LiveRecorder; steps: WorkflowStep[] }> {
    const recorder = new WorkflowRecorder('Delete customer');
    const live = new LiveRecorder(page, recorder);
    await page.goto(baseUrl);
    await live.attach();
    await page.locator('#search').fill('Ada');
    await page.locator('#search').press('Tab');
    await page.waitForTimeout(200);
    live.markVariable(0, { name: 'customer' });
    await nameCell('#people', 'Ada').getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(200);
    return { recorder, live, steps: recorder.finish().steps };
  }

  async function replayDelete(step: WorkflowStep, variables: Record<string, unknown>, query = ''): Promise<string[]> {
    await page.goto(baseUrl + query);
    const resolved = await resolveRowStep(page, step, variables);
    expect(resolved).toBeDefined();
    await page.locator(resolved!.scopedSelectors[0]).click();
    return page.evaluate(() => (window as unknown as { deleted: string[] }).deleted);
  }

  it('records the row of a click, bound to the Variable typed earlier, without the recorded text in any selector', async () => {
    const { steps } = await recordDeleteAda();
    const del = steps[steps.length - 1];
    expect(del.rowBinding).toEqual({
      container: { kind: 'row' },
      key: { text: 'Ada', column: 'Name' },
      variable: 'customer',
    });
    expect(del.selectors.some((s) => s.includes('has-text') || s.includes('Ada'))).toBe(false);
    expect(del.selectors.some((s) => s.includes(':nth-of-type') || s.includes('first'))).toBe(false);
    expect(del.anchor?.parent).toBeUndefined();
    expect(del.risk).toBe('delete');
  }, 60000);

  it('chooses the row of the Variable value whatever the order of the rows', async () => {
    const { steps } = await recordDeleteAda();
    const del = steps[steps.length - 1];
    for (const order of ['asc', 'desc', 'rot']) {
      // "Bob" is also the manager of other rows: only the Name column counts
      expect(await replayDelete(del, { customer: 'Bob' }, `?order=${order}`)).toEqual(['Bob']);
      expect(await replayDelete(del, { customer: 'Ada' }, `?order=${order}`)).toEqual(['Ada']);
    }
  }, 60000);

  it('finds rows whose text has quotes, regex characters, accents or odd spacing', async () => {
    const { steps } = await recordDeleteAda();
    const del = steps[steps.length - 1];
    for (const name of ['O\'Brien "Q"', 'A+B (x) [y]', 'José', 'jose\u0301', 'zoë müller']) {
      const deleted = await replayDelete(del, { customer: name }, '?order=rot');
      expect(deleted).toHaveLength(1);
      expect(deleted[0].normalize('NFC').toLowerCase().replace(/\s+/g, ' ')).toBe(name.normalize('NFC').toLowerCase());
    }
  }, 60000);

  it('reports AMBIGUOUS_ROW with the texts of the matching rows, and ROW_NOT_FOUND for no row', async () => {
    const { steps } = await recordDeleteAda();
    const del = steps[steps.length - 1];

    await page.goto(baseUrl + '?dup=1');
    const ambiguous = await resolveRowStep(page, del, { customer: 'Bob' }).catch((e: Error) => e);
    expect(ambiguous).toBeInstanceOf(Error);
    expect((ambiguous as Error).message).toMatch(/AMBIGUOUS_ROW: 2 rows match "Bob"/);
    expect((ambiguous as Error).message).toContain('Bob Ada');
    expect((ambiguous as Error).message).toContain('Bob Zed');

    await page.goto(baseUrl);
    const missing = await resolveRowStep(page, del, { customer: 'Nobody' }).catch((e: Error) => e);
    expect((missing as Error).message).toMatch(/ROW_NOT_FOUND: no row matches "Nobody"/);

    // 2.10 and 2.11: the Variable is omitted, so the recorded key selects the row; with no key it still fails
    expect((await resolveRowStep(page, del, {}))?.hasText).toBe('Ada');
    const keyless = { ...del, rowBinding: { ...del.rowBinding!, key: undefined } } as WorkflowStep;
    await expect(resolveRowStep(page, keyless, {})).rejects.toThrow(/ROW_VARIABLE_MISSING/);
  }, 60000);

  it('binds a card to a Variable made from a text selected in it, and resolves it in shuffled cards', async () => {
    const recorder = new WorkflowRecorder('Delete card');
    const live = new LiveRecorder(page, recorder);
    await page.goto(baseUrl);
    await live.attach();

    // The user selects the name in the card and names the variable in the page box
    await page.locator('#cards .card h3', { hasText: 'Grace' }).selectText();
    await page.getByRole('button', { name: 'Make variable' }).click();
    await page.locator('[data-daemonize-action=variable-name]').fill('person');
    await page.locator('[data-daemonize-action=confirm-variable]').click();
    await page.waitForTimeout(200);
    await page.locator('#cards .card', { hasText: 'Grace' }).getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(200);

    const workflow = recorder.finish();
    expect(workflow.variables.map((v) => v.name)).toEqual(['person']);
    const del = workflow.steps[workflow.steps.length - 1];
    expect(del.rowBinding?.container.kind).toBe('card');
    expect(del.rowBinding?.container.selectorHint).toBe('div.card');
    expect(del.rowBinding?.variable).toBe('person');

    for (const order of ['asc', 'desc', 'rot']) {
      expect(await replayDelete(del, { person: 'Bob' }, `?order=${order}`)).toEqual(['card:Bob']);
    }

    await page.goto(baseUrl + '?cardsdup=1');
    await expect(resolveRowStep(page, del, { person: 'Bob' })).rejects.toThrow(/AMBIGUOUS_ROW: 2 rows match/);
  }, 60000);

  it('binds a row to a Variable afterwards with bindRowToVariable', async () => {
    const recorder = new WorkflowRecorder('Delete customer');
    const live = new LiveRecorder(page, recorder);
    await page.goto(baseUrl);
    await live.attach();
    await nameCell('#people', 'Grace').getByRole('button', { name: 'Delete' }).click();
    await page.locator('#search').fill('Grace');
    await page.locator('#search').press('Tab');
    await page.waitForTimeout(200);

    live.markVariable(1, { name: 'customer' });
    expect(() => live.bindRowToVariable(0, 'nope')).toThrow(/not defined/);
    live.bindRowToVariable(0, 'customer');

    const step = recorder.finish().steps[0];
    expect(step.rowBinding).toEqual({ container: { kind: 'row' }, key: { text: 'Grace', column: 'Name' }, variable: 'customer' });
    expect(await replayDelete(step, { customer: 'Bob' }, '?order=desc')).toEqual(['Bob']);
  }, 60000);
});
