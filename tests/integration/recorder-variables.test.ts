import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

const PAGE = readFileSync(new URL('../fixtures/web/recorder-controls.html', import.meta.url), 'utf8');

/** Browser test of the "Make variable" box and the Field_Drawer on recorder-controls.html. */
describe('recorder variables in the page (type, optional, earlier fields, edit)', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
  }, 60000);

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page?.close();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => httpServer?.close(() => done()));
  });

  async function attach(studio = true): Promise<{ live: LiveRecorder; recorder: WorkflowRecorder }> {
    const recorder = new WorkflowRecorder('Controls');
    const live = new LiveRecorder(page, recorder, { studio });
    await page.goto(baseUrl);
    await live.attach();
    return { live, recorder };
  }

  const ui = (): ReturnType<Page['locator']> => page.locator('[data-daemonize-ui]');
  const action = (name: string): ReturnType<Page['locator']> => page.locator(`[data-daemonize-action=${name}]`);

  async function typeIn(selector: string, text: string, live: LiveRecorder, steps: number): Promise<void> {
    await page.locator(selector).click();
    await page.keyboard.type(text);
    await page.locator('#go').focus(); // leaving the field records it
    await expect.poll(() => live.stepCount, { timeout: 5000 }).toBeGreaterThanOrEqual(steps);
  }

  async function openFields(): Promise<void> {
    await page.getByRole('button', { name: 'Finish and save' }).click();
    await action('review-fields').click();
    await action('field-drawer').waitFor();
  }

  it('makes an earlier field a variable after typing in another one, from the field list', async () => {
    const { live, recorder } = await attach();
    await typeIn('#full', 'Ada', live, 1);
    await typeIn('#age', 'abc', live, 2);
    await openFields();
    const rows = action('review-field');
    await expect.poll(() => rows.count()).toBe(2);
    await rows.first().click();
    const name = action('variable-name');
    await name.fill('customer');
    await name.press('Enter');
    await expect.poll(() => recorder.variableList().map((v) => v.name)).toEqual(['customer']);
    expect(recorder.variableList()[0]).toMatchObject({ name: 'customer', type: 'string' });
    expect(recorder.stepsSoFar()[0].variable).toBe('customer');
    expect(live.stepCount).toBe(2); // the box recorded no step of its own
  });

  it('edits and renames a variable in the field list, sending only what changed', async () => {
    const { live, recorder } = await attach();
    await typeIn('#full', 'Ada', live, 1);
    await page.getByRole('button', { name: 'Make variable' }).click();
    await action('variable-name').fill('customer');
    await action('variable-name').press('Enter');
    await expect.poll(() => recorder.variableList().length).toBe(1);

    await openFields();
    await action('review-field').first().click();
    const name = action('variable-name');
    expect(await name.inputValue()).toBe('customer');
    await name.fill('buyer');
    await action('variable-optional').check();
    await action('variable-omitted').selectOption('useRecorded');
    await name.press('Enter');
    await expect.poll(() => recorder.variableList()[0]?.name).toBe('buyer');
    const workflow = recorder.finish();
    expect(workflow.variables).toEqual([{ name: 'buyer', description: 'Full name', type: 'string', optional: true, whenOmitted: 'useRecorded' }]);
    expect(workflow.steps[0].variable).toBe('buyer');
    expect(workflow.observedPayloads).toEqual([{ buyer: 'Ada' }]);
  });

  it('keeps the box open with the error next to the name when the request is refused', async () => {
    const { live, recorder } = await attach();
    await typeIn('#age', 'abc', live, 1);
    await page.getByRole('button', { name: 'Make variable' }).click();
    await action('variable-name').fill('age');
    await action('variable-type').selectOption('number');
    await action('variable-optional').check();
    await action('variable-name').press('Enter');
    await expect.poll(async () => (await ui().textContent()) ?? '').toContain('not a number');
    // Name, type and optional setting are still there
    expect(await action('variable-name').inputValue()).toBe('age');
    expect(await action('variable-type').inputValue()).toBe('number');
    expect(await action('variable-optional').isChecked()).toBe(true);
    expect(recorder.variableList()).toEqual([]);
    // Fixing the type lets the same box finish
    await action('variable-type').selectOption('string');
    await action('variable-name').press('Enter');
    await expect.poll(() => recorder.variableList().length).toBe(1);
    expect(recorder.variableList()[0]).toMatchObject({ name: 'age', type: 'string', optional: true, whenOmitted: 'skip' });
  });

  it('holds "Save and add to Kiro" back while a variable edit is open', async () => {
    const { live } = await attach();
    await typeIn('#full', 'Ada', live, 1);
    await openFields();
    await action('review-field').first().click();
    await action('variable-name').waitFor();
    await action('finish-kiro').click();
    const ended = await Promise.race([live.ended, new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 700))]);
    expect(ended).toBe('still open');
    expect(live.finishIntent).toBe('save');
    expect(await action('variable-name').isVisible()).toBe(true);
    expect((await ui().textContent()) ?? '').toContain('open variable edit');
    // After cancelling the edit the same button ends the recording
    await action('cancel-variable').click();
    await action('finish-kiro').click();
    expect(await live.ended).toBe('panel');
    expect(live.finishIntent).toBe('kiro');
  });

  it('completes "Make variable" with the keyboard alone, in the order name, type, optional, omitted choice', async () => {
    const { live, recorder } = await attach();
    await typeIn('#full', 'Ada', live, 1);
    await page.getByRole('button', { name: 'Make variable' }).focus();
    await page.keyboard.press('Enter');
    const focusedLabel = (): Promise<string | null> => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? el.getAttribute('aria-label') : null;
    });
    expect(await focusedLabel()).toBe('Variable name');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('who');
    await page.keyboard.press('Tab');
    expect(await focusedLabel()).toBe('Type');
    await page.keyboard.press('Tab');
    expect(await focusedLabel()).toBe('Optional');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    expect(await focusedLabel()).toBe('If left empty');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => recorder.variableList().length).toBe(1);
    expect(recorder.variableList()[0]).toMatchObject({ name: 'who', type: 'string', optional: true, whenOmitted: 'useRecorded' });
  });
});
