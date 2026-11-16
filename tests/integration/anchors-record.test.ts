import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { record } from '../../src/cli/commands/record.js';
import type { WorkflowStep } from '../../src/types.js';

const FIXTURES = new URL('../fixtures/web/', import.meta.url);

describe('recording accessible anchors, frames, popups and custom components', () => {
  let httpServer: Server;
  let browser: Browser;
  let page: Page;
  let baseUrl: string;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'daemonize-anchors-'));
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
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;

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
    await new Promise<void>((done) => httpServer?.close(() => done()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function settle(): Promise<void> {
    await page.waitForTimeout(200);
  }

  async function startRecording(path: string): Promise<{ recorder: WorkflowRecorder; live: LiveRecorder }> {
    const recorder = new WorkflowRecorder('Anchors');
    const live = new LiveRecorder(page, recorder);
    await page.goto(baseUrl + path);
    await live.attach();
    return { recorder, live };
  }

  /** `action:role:name` of every step, for a compact view of what was recorded. */
  function summary(steps: WorkflowStep[]): string[] {
    return steps.map((s) => `${s.actionType}:${s.anchor?.role ?? '-'}:${s.anchor?.name ?? '-'}`);
  }

  it('records a custom combobox rendered in a portal as two clicks, and tells two "Save" buttons apart', async () => {
    const { recorder } = await startRecording('portal.html');

    await page.locator('#plan-trigger').click();
    await page.getByRole('option', { name: 'Pro' }).click();
    await page.locator('form').getByRole('button', { name: 'Save' }).click();
    await page.locator('#open-dialog').click();
    await page.locator('#dialog-save').click();
    await settle();

    const steps = recorder.finish().steps;
    expect(summary(steps)).toEqual([
      'click:combobox:Plan',
      'click:option:Pro',
      'click:button:Save',
      'click:button:Edit customer',
      'click:button:Save',
    ]);
    // No native select step for a custom component
    expect(steps.some((s) => s.actionType === 'select')).toBe(false);

    // The option lives in a portal: its context is the listbox, not the form
    expect(steps[1].anchor?.parent).toEqual({ kind: 'region', name: 'Plan options' });
    expect(steps[1].selectors[0]).toBe('role=listbox[name="Plan options"] >> role=option[name="Pro"]');

    // The two "Save" buttons differ by their parent context
    const pageSave = steps[2];
    const dialogSave = steps[4];
    expect(pageSave.anchor?.parent).toEqual({ kind: 'region', name: 'Customer' });
    expect(dialogSave.anchor?.parent).toEqual({ kind: 'dialog', name: 'Edit customer details' });
    expect(dialogSave.selectors[0]).toBe('role=dialog[name="Edit customer details"] >> role=button[name="Save"]');
    expect(pageSave.selectors[0]).toBe('role=button[name="Save"]');
    expect(pageSave.anchor).not.toEqual(dialogSave.anchor);

    // Risk: the submit button writes, the others read
    expect(steps.map((s) => s.risk)).toEqual(['read', 'read', 'write', 'read', 'write']);
  }, 60000);

  it('records the iframe index chain, with hints, for actions inside nested frames', async () => {
    const { recorder } = await startRecording('frame-outer.html');

    const child = page.frameLocator('iframe[name=child]');
    await child.locator('#q').click();
    await page.keyboard.type('cats');
    await child.getByRole('button', { name: 'Search' }).click();
    await child.frameLocator('iframe[name=deep]').getByRole('button', { name: 'Deep action' }).click();
    await settle();

    const steps = recorder.finish().steps;
    expect(summary(steps)).toEqual([
      'type:textbox:Query',
      'click:button:Search',
      'click:button:Deep action',
    ]);
    expect(steps[0].value).toBe('cats');
    // The target frame is the second iframe of the page, so the index is 1, not 0
    expect(steps[0].anchor?.frame).toEqual([1]);
    expect(steps[1].anchor?.frame).toEqual([1]);
    expect(steps[1].anchor?.frameHints).toEqual([
      { name: 'child', title: 'Search frame', src: '/frame-inner.html' },
    ]);
    expect(steps[2].anchor?.frame).toEqual([1, 0]);
    expect(steps[2].anchor?.frameHints?.map((h) => h.name)).toEqual(['child', 'deep']);
  }, 60000);

  it('records the opening of a popup as a switch_page step and the steps on each page', async () => {
    const out = join(tempDir, 'popup.json');
    await record({
      url: baseUrl + 'popup.html',
      name: 'popup-app',
      label: 'Popup flow',
      out,
      headless: true,
      drive: async (opener) => {
        const [popup] = await Promise.all([
          opener.context().waitForEvent('page'),
          opener.getByRole('button', { name: 'Open details' }).click(),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        await popup.waitForTimeout(500);
        await popup.getByRole('button', { name: 'Confirm' }).click();
        await popup.waitForTimeout(300);
        await opener.getByRole('button', { name: 'Main action' }).click();
        await opener.waitForTimeout(300);
      },
    });

    const steps: WorkflowStep[] = JSON.parse(readFileSync(out, 'utf8')).workflows[0].steps;
    expect(summary(steps)).toEqual([
      'click:button:Open details',
      'switch_page:document:Details popup',
      'click:button:Confirm',
      expect.stringMatching(/^switch_page:document:/),
      'click:button:Main action',
    ]);
    expect(steps[1].anchor?.popup).toEqual({ page: 1, opens: true });
    expect(steps[1].selectors).toEqual([]);
    expect(steps[3].anchor?.popup).toEqual({ page: 0 });
  }, 60000);

  it('records typing in a contenteditable element as a type step with the editable anchor', async () => {
    const { recorder } = await startRecording('editable.html');

    await page.locator('#editor').click();
    await page.keyboard.type('Call Ada');
    await page.locator('#bare').click(); // leaving the editor records it
    await page.keyboard.type('Plain');
    await page.locator('#done').click();
    await settle();

    const steps = recorder.finish().steps;
    expect(summary(steps)).toEqual([
      'type:textbox:Notes',
      'type:textbox:',
      'click:button:Done',
    ]);
    expect(steps[0].value).toBe('Call Ada');
    expect(steps[0].selectors[0]).toBe('role=textbox[name="Notes"]');
    expect(steps[1].value).toBe('Plain');
  }, 60000);

  it('tells the three "Delete" buttons of a table apart by their row, and marks them as delete', async () => {
    const { recorder } = await startRecording('table.html');

    for (const row of ['Ada Lovelace', 'Grace Hopper', 'Alan Turing']) {
      await page.locator('tr', { hasText: row }).getByRole('button', { name: 'Delete' }).click();
    }
    await settle();

    const steps = recorder.finish().steps;
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.risk)).toEqual(['delete', 'delete', 'delete']);
    expect(steps.map((s) => s.anchor?.parent?.name)).toEqual([
      'Ada Lovelace ada@example.com',
      'Grace Hopper grace@example.com',
      'Alan Turing alan@example.com',
    ]);
    expect(steps.map((s) => s.selectors[0])).toEqual([
      'role=button[name="Delete"]',
      'role=button[name="Delete"]',
      'role=button[name="Delete"]',
    ]);
    // The row comes from rowBinding, found at replay by the value of a Variable
    expect(steps.map((s) => s.rowBinding?.key?.text)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Alan Turing']);
    expect(steps.flatMap((s) => s.selectors).some((s) => s.includes('has-text'))).toBe(false);
    // No positional selector next to the accessible ones
    expect(steps.flatMap((s) => s.selectors).some((s) => s.includes(':nth-of-type'))).toBe(false);
  }, 60000);

  it('records a hover only when the next click target was hidden until the hover', async () => {
    const { recorder } = await startRecording('hover.html');

    await page.locator('#plain').click();
    await page.locator('#products').hover();
    await page.getByRole('link', { name: 'Pricing' }).click();
    await settle();

    expect(summary(recorder.finish().steps)).toEqual([
      'click:button:Plain',
      'hover:link:Products',
      'click:link:Pricing',
    ]);
  }, 60000);

  it('records a scrollIntoView only when the click target was outside the viewport', async () => {
    const { recorder } = await startRecording('scroll.html');

    await page.locator('#top').click();
    await page.locator('#bottom').click();
    await settle();

    expect(summary(recorder.finish().steps)).toEqual([
      'click:button:Top action',
      'scrollIntoView:button:Bottom action',
      'click:button:Bottom action',
    ]);
  }, 60000);

  it('never records the value of password, one-time-code and token fields', async () => {
    const out = join(tempDir, 'login.json');
    await record({
      url: baseUrl + 'login.html',
      name: 'login-app',
      label: 'Sign in',
      out,
      headless: true,
      drive: async (login) => {
        await login.locator('#user').click();
        await login.keyboard.type('ada');
        await login.locator('#pass').click();
        await login.keyboard.type('hunter2-s3cret');
        await login.locator('#code').click();
        await login.keyboard.type('481516');
        await login.locator('#tk').click();
        await login.keyboard.type('tok_live_2342');
        await login.getByRole('button', { name: 'Sign in' }).click();
        await login.waitForTimeout(300);
      },
    });

    const json = readFileSync(out, 'utf8');
    for (const secret of ['hunter2-s3cret', '481516', 'tok_live_2342']) {
      expect(json).not.toContain(secret);
    }

    const steps: WorkflowStep[] = JSON.parse(json).workflows[0].steps;
    expect(steps.map((s) => [s.actionType, s.secretRef ?? null, s.value ?? null])).toEqual([
      ['type', null, 'ada'],
      ['type', 'PASSWORD', null],
      ['type', 'OTP', null],
      ['type', 'TOKEN', null],
      ['click', null, null],
    ]);
    expect(steps[4].risk).toBe('write');
  }, 60000);
});
