import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { createWebRun, executeWebStep } from '../../src/replay/runtime/web-steps.js';
import type { StepLike } from '../../src/replay/runtime/step-plan.js';

const PAGE = readFileSync(new URL('../fixtures/web/recorder-controls.html', import.meta.url), 'utf8');

/** Browser test of the capture of checkboxes, switches, radio groups and file fields. */
describe('recorder: check, radio and file capture', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    dir = mkdtempSync(join(tmpdir(), 'daemonize-controls-'));
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
    rmSync(dir, { recursive: true, force: true });
  });

  async function attach(): Promise<{ live: LiveRecorder; recorder: WorkflowRecorder }> {
    const recorder = new WorkflowRecorder('Controls');
    const live = new LiveRecorder(page, recorder, { studio: true, kiroHomeExists: true });
    await page.goto(baseUrl);
    await live.attach();
    return { live, recorder };
  }

  const action = (name: string): ReturnType<Page['locator']> => page.locator(`[data-daemonize-action=${name}]`);

  it('records a checkbox and a switch as check steps with the state after the click', async () => {
    const { live, recorder } = await attach();
    await page.locator('#news').check();
    await expect.poll(() => live.stepCount).toBe(1);
    await page.locator('#notify').click();
    await expect.poll(() => live.stepCount).toBe(2);
    await page.locator('#notify').click();
    await page.locator('#agree').click();
    await expect.poll(() => live.stepCount).toBe(4);
    const steps = recorder.stepsSoFar();
    expect(steps.map((s) => [s.actionType, s.value])).toEqual([
      ['check', 'true'], ['check', 'true'], ['check', 'false'], ['check', 'true'],
    ]);
    expect(steps[0].risk).toBe('read');
  });

  it('turns a check step into a boolean variable and refuses another type', async () => {
    const { live, recorder } = await attach();
    await page.locator('#news').check();
    await expect.poll(() => live.stepCount).toBe(1);
    await page.getByRole('button', { name: 'Make variable' }).click();
    // The type is fixed to true or false for a checkbox
    expect(await action('variable-type').locator('option').count()).toBe(1);
    await action('variable-name').fill('newsletter');
    await action('variable-name').press('Enter');
    await expect.poll(() => recorder.variableList().length).toBe(1);
    expect(recorder.variableList()[0]).toMatchObject({ name: 'newsletter', type: 'boolean' });
    expect(recorder.finish().observedPayloads).toEqual([{ newsletter: true }]);
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'other', type: 'number' })).toMatchObject({ ok: false });
  });

  it('turns a radio group into a choice variable listing the enabled radios in document order', async () => {
    const { live, recorder } = await attach();
    await page.getByLabel('Pro').check();
    await expect.poll(() => live.stepCount).toBe(1);
    await page.getByRole('button', { name: 'Make variable' }).click();
    // No type choice for a radio group
    expect(await action('variable-type').count()).toBe(0);
    await action('variable-name').fill('plan');
    await action('variable-name').press('Enter');
    await expect.poll(() => recorder.variableList().length).toBe(1);
    const workflow = recorder.finish();
    expect(workflow.variables).toEqual([{ name: 'plan', type: 'string', enum: ['Free', 'Pro', 'Team'] }]);
    expect(workflow.steps[0]).toMatchObject({ actionType: 'click', value: 'Pro', variable: 'plan' });
    expect(workflow.observedPayloads).toEqual([{ plan: 'Pro' }]);
  });

  it('reads a radiogroup made of role=radio elements, and skips a disabled radio in the list', async () => {
    const { live, recorder } = await attach();
    await page.locator('#size-l').click();
    await expect.poll(() => live.stepCount).toBe(1);
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'size', type: 'string' })).toEqual({ ok: true });
    expect(recorder.variableList()[0].enum).toEqual(['Small', 'Large']);

    await page.getByLabel('Standard').check();
    await expect.poll(() => live.stepCount).toBe(2);
    expect(live.handleMarkVariable({ stepIndex: 1, name: 'delivery', type: 'string' })).toEqual({ ok: true });
    expect(recorder.variableList()[1].enum).toEqual(['Standard']);
  });

  it('refuses a radio group that cannot be listed and keeps the click as recorded', async () => {
    const { live, recorder } = await attach();
    await page.getByLabel('Only one').check();
    await page.getByLabel('Same').first().check();
    await expect.poll(() => live.stepCount).toBe(2);
    const alone = live.handleMarkVariable({ stepIndex: 0, name: 'alone', type: 'string' });
    const twins = live.handleMarkVariable({ stepIndex: 1, name: 'twins', type: 'string' });
    expect(alone).toMatchObject({ ok: false });
    expect(twins).toMatchObject({ ok: false });
    expect(recorder.variableList()).toEqual([]);
    expect(recorder.stepsSoFar().map((s) => [s.actionType, s.value, s.variable])).toEqual([
      ['click', undefined, undefined], ['click', undefined, undefined],
    ]);
  });

  it('records no step for a file choice, shows the notice, and counts the field once on the end sheet', async () => {
    const { live, recorder } = await attach();
    const file = join(dir, 'private-name.txt');
    writeFileSync(file, 'secret contents');
    await page.locator('#doc').setInputFiles(file);
    const status = page.locator('[data-daemonize-ui] p[role=status]');
    await expect.poll(async () => (await status.first().textContent()) ?? '', { timeout: 500 }).toContain('File upload is not supported yet');
    const text = (await page.locator('[data-daemonize-ui]').textContent()) ?? '';
    expect(text).not.toContain('private-name');
    expect(text).not.toContain('txt');
    // Choosing again in the same field counts it once
    await page.locator('#doc').setInputFiles(file);
    await expect.poll(() => live.unrecordedFileFields).toBe(1);
    await page.waitForTimeout(200);
    expect(live.unrecordedFileFields).toBe(1);
    expect(live.stepCount).toBe(0);
    expect(recorder.variableList()).toEqual([]);
    expect(live.panelFields()).toEqual({ fields: [] });

    await page.getByRole('button', { name: 'Finish and save' }).click();
    await expect.poll(async () => (await action('file-count').textContent()) ?? '').toContain('1 file field was not recorded');
  });

  it('shows the scope choice on the end sheet and sends it only with "Save and add to Kiro"', async () => {
    const { live } = await attach();
    await page.locator('#news').check();
    await expect.poll(() => live.stepCount).toBe(1);
    await page.getByRole('button', { name: 'Finish and save' }).click();
    const group = page.getByRole('radiogroup', { name: 'Where to add the tool' });
    await group.waitFor();
    expect(await page.getByRole('radio', { name: 'All my projects' }).isChecked()).toBe(true);
    await page.getByRole('radio', { name: 'Only this project' }).check();
    await action('finish-kiro').click();
    expect(await live.ended).toBe('panel');
    expect(live.finishIntent).toBe('kiro');
    expect(live.finishScope).toBe('project');
  });

  it('shows the radio group label in Review fields, refreshes the End Sheet pill, and replays the <fieldset><legend> radio variable', async () => {
    const { live, recorder } = await attach();
    await page.locator('#full').click();
    await page.keyboard.type('Ada');
    await page.getByLabel('Pro').check();
    await expect.poll(() => live.stepCount).toBe(2);

    // Suggested variable name from the "Make variable" bar comes from the <legend> "Plan"
    await page.getByRole('button', { name: 'Make variable' }).click();
    expect(await action('variable-name').inputValue()).toBe('plan');
    await action('variable-optional').check();
    await action('confirm-variable').click();
    await expect.poll(() => recorder.variableList().length).toBe(1);

    // End Sheet opens with "Variable: plan", user selects "Only this project", then opens Review fields
    await page.getByRole('button', { name: 'Finish and save' }).click();
    await expect.poll(async () => (await action('sheet-facts').textContent()) ?? '').toContain('Variable: plan');
    await page.getByRole('radio', { name: 'Only this project' }).check();

    await action('review-fields').click();
    await action('field-drawer').waitFor();
    const labels = await action('review-field').allInnerTexts();
    expect(labels).toEqual(['type Full name', 'choose Plan']);

    // Adding a variable in Review fields refreshes the End Sheet summary pill and keeps the chosen scope
    await action('review-field').first().click();
    await action('variable-name').fill('customer');
    await action('confirm-variable').click();
    await expect.poll(async () => (await action('sheet-facts').textContent()) ?? '').toContain('2 variables');

    await action('close-drawer').click();
    expect(await action('sheet-facts').textContent()).toContain('2 variables');
    expect(await page.getByRole('radio', { name: 'Only this project' }).isChecked()).toBe(true);

    // Replay the recorded radio step inside <fieldset><legend>Plan</legend> with a different value
    const workflow = recorder.finish();
    const replayPage = await browser.newPage();
    try {
      await replayPage.goto(baseUrl);
      const run = createWebRun(replayPage.context(), replayPage);
      await executeWebStep(run, workflow.steps[1] as unknown as StepLike, { plan: 'Team' }, { timeoutMs: 2000 });
      expect(await replayPage.getByLabel('Team').isChecked()).toBe(true);
      await executeWebStep(run, workflow.steps[1] as unknown as StepLike, { plan: 'Free' }, { timeoutMs: 2000 });
      expect(await replayPage.getByLabel('Free').isChecked()).toBe(true);
    } finally {
      await replayPage.close();
    }
  });
});
