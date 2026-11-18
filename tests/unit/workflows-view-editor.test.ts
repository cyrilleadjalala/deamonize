import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { SAMPLE_WEB_SET } from '../../src/studio/sample-data.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { removeDir } from '../helpers/cleanup.js';
// @ts-expect-error no type declarations for the browser modules
import { COPY_EDITOR, allEditorCopyTexts } from '../../src/studio/ui/js/copy-editor.js';
import type { WorkflowSet } from '../../src/types.js';

vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });

// The Workflows view against a live Studio and a real workflow file, in real Chromium. Failures (400, 404, 409, 5xx, no
// answer) are produced by route interception in front of the real server.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;

const makeSet = (): WorkflowSet => ({
  version: '1',
  targetType: 'web',
  targetName: 'Shop',
  startUrl: 'https://shop.example.com/',
  workflows: [
    {
      id: A,
      label: 'Find order',
      description: 'Looks an order up',
      steps: [{ actionType: 'type', selectors: ['role=textbox'], variable: 'order_id', value: '12' }],
      variables: [
        { name: 'order_id', type: 'string' },
        { name: 'note', type: 'string', optional: true, whenOmitted: 'skip' },
        { name: 'urgent', type: 'boolean', optional: true },
      ],
      observedPayloads: [{ order_id: '12', note: 'x', urgent: true }],
    },
    {
      id: B,
      label: 'Open admin',
      startUrl: 'https://shop.example.com/admin?x=1#frag',
      steps: [{ actionType: 'click', selectors: ['role=button'] }],
      variables: [],
      observedPayloads: [],
    },
  ],
});

describe('Workflows view: editor controls (real Chromium, live Studio)', () => {
  let dir: string;
  let file: string;
  let studio: StudioHandle;
  let sampleStudio: StudioHandle;
  let browser: Browser;
  let page: Page;
  let base: string;
  let posts: Array<{ path: string; body: any }>;

  const json = (route: Route, status: number, body: unknown): Promise<void> => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const open = async (hash: string, from = base): Promise<void> => {
    await page.goto('about:blank');
    await page.goto(`${from}/${hash}`);
    await page.waitForSelector('main h1, main h2', { state: 'visible' });
    await page.waitForFunction(() => document.querySelector('main[aria-busy]') === null);
  };
  const live = (): Promise<string> => page.locator('#live').textContent().then((t) => t ?? '');
  const onDisk = async (): Promise<WorkflowSet> => deserializeWorkflowSet(await readFile(file, 'utf-8'));
  /** Answers the next call of an editor route with a fixed status instead of reaching the server. */
  const answer = async (path: string, status: number, body: unknown): Promise<void> => {
    await page.unroute(`**${path}`);
    await page.route(`**${path}`, (route) => json(route, status, body));
  };
  const passThrough = async (): Promise<void> => {
    await page.unroute('**/api/workflows/update');
    await page.unroute('**/api/workflows/delete');
    for (const path of ['/api/workflows/update', '/api/workflows/delete']) {
      await page.route(`**${path}`, async (route) => {
        posts.push({ path, body: JSON.parse(route.request().postData() ?? '{}') });
        await route.continue();
      });
    }
  };
  const visibleText = (selector: string): Promise<string> => page.locator(selector).first().innerText();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wf-view-editor-'));
    file = join(dir, 'daemonize.workflows.json');
    await writeFile(file, serializeWorkflowSet(makeSet()));
    studio = await startStudio({ workflowFile: file, outDir: join(dir, 'out'), env: {} });
    base = studio.url.replace(/\/\?token=.*$/, '');
    sampleStudio = await startStudio({ workflowFile: join(dir, 'sample.json'), outDir: join(dir, 'sample-out'), env: {}, sampleData: true });
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(studio.url);
    await page.waitForSelector('main h1');
  }, 120000);
  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    await sampleStudio?.close();
    if (dir) await removeDir(dir);
  });
  beforeEach(async () => {
    posts = [];
    await writeFile(file, serializeWorkflowSet(makeSet()));
    await mkdir(`${file}.assets`, { recursive: true });
    await passThrough();
  });

  it('shows the three controls as buttons that Tab reaches, and no start page line when it does not differ', async () => {
    await open(`#/workflows/${A}`);
    for (const label of [COPY_EDITOR.renameButton, COPY_EDITOR.inputsButton, COPY_EDITOR.deleteButton]) {
      const button = page.getByRole('button', { name: label, exact: true });
      expect(await button.count()).toBe(1);
      expect(await button.evaluate((el) => el.tagName + el.getAttribute('tabindex'))).toBe('BUTTONnull');
    }
    await page.locator('#wf-rename').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-inputs');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete');
    expect(await page.getByText(COPY_EDITOR.startPageLabel, { exact: true }).count()).toBe(0);
  });

  it('shows the start page without query or fragment only for a workflow that has its own', async () => {
    await open(`#/workflows/${B}`);
    expect(await page.getByText(COPY_EDITOR.startPageLabel, { exact: true }).count()).toBe(1);
    const shown = await page.locator('dt:has-text("Start page") + dd').innerText();
    expect(shown).toBe('https://shop.example.com/admin');
  });

  it('shows no control in sample mode', async () => {
    const sampleBase = sampleStudio.url.replace(/\/\?token=.*$/, '');
    await page.goto(sampleStudio.url);
    await open(`#/workflows/${SAMPLE_WEB_SET.workflows[0].id}`, sampleBase);
    expect(await page.locator('.wf-detail').count()).toBe(1);
    expect(await page.locator('#wf-rename, #wf-inputs, #wf-delete').count()).toBe(0);
    await page.goto(studio.url);
  });

  it('prefills "Rename and describe" and sends only what changed, then shows the result', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-rename').click();
    expect(await page.locator('#wf-name-input').inputValue()).toBe('Find order');
    expect(await page.locator('#wf-description-input').inputValue()).toBe('Looks an order up');
    expect(await page.getByLabel(COPY_EDITOR.nameLabel, { exact: true }).count()).toBe(1);
    expect(await page.getByLabel(COPY_EDITOR.descriptionLabel, { exact: true }).count()).toBe(1);
    await page.locator('#wf-name-input').fill('Find an order');
    await page.locator('#wf-rename-save').click();
    await page.waitForFunction(() => document.querySelector('#wf-title')?.textContent === 'Find an order');
    expect(posts).toEqual([{ path: '/api/workflows/update', body: { id: A, label: 'Find an order' } }]);
    expect((await onDisk()).workflows[0].label).toBe('Find an order');
    expect(await page.locator('#wf-rename-form').count()).toBe(0);
    await page.waitForFunction(() => document.getElementById('live')?.textContent === 'The action was updated.');
    expect(await live()).toBe(COPY_EDITOR.updated);
  });

  it('sends nothing when nothing changed in the rename form', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-rename').click();
    await page.locator('#wf-rename-save').click();
    expect(await visibleText('#wf-rename-error')).toBe(COPY_EDITOR.nothingChanged);
    expect(posts).toEqual([]);
  });

  it('shows 400, 404 and 409 answers in a role=alert beside the form and keeps what was typed', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-rename').click();
    await page.locator('#wf-name-input').fill('Typed name');
    await page.locator('#wf-description-input').fill('Typed description');
    for (const status of [400, 404, 409]) {
      await answer('/api/workflows/update', status, { error: `Message ${status}` });
      await page.locator('#wf-rename-save').click();
      await page.waitForFunction((s) => document.querySelector('#wf-rename-error')?.textContent === `Message ${s}`, status);
      expect(await page.locator('#wf-rename-error').getAttribute('role')).toBe('alert');
      expect(await page.locator('#wf-name-input').inputValue()).toBe('Typed name');
      expect(await page.locator('#wf-description-input').inputValue()).toBe('Typed description');
      expect(await page.locator('#wf-title').innerText()).toBe('Find order');
    }
  });

  it('says the change was not saved after a server error or no answer, keeping the values', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-rename').click();
    await page.locator('#wf-name-input').fill('Typed name');
    await answer('/api/workflows/update', 500, { error: 'internal error' });
    await page.locator('#wf-rename-save').click();
    await page.waitForFunction((t) => document.querySelector('#wf-rename-error')?.textContent === t, COPY_EDITOR.notSaved);
    await page.unroute('**/api/workflows/update');
    await page.route('**/api/workflows/update', (route) => route.abort());
    await page.locator('#wf-rename-save').click();
    await page.waitForFunction((t) => document.querySelector('#wf-rename-error')?.textContent === t, COPY_EDITOR.notSaved);
    expect(await page.locator('#wf-name-input').inputValue()).toBe('Typed name');
    expect((await onDisk()).workflows[0].label).toBe('Find order');
  });

  it('lists one row per input, hides "If left empty" until Optional is checked, and sends only changed inputs', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-inputs').click();
    expect(await page.locator('.wf-input-row').count()).toBe(3);
    expect(await page.locator('#wf-var-name-0').inputValue()).toBe('order_id');
    expect(await page.locator('#wf-var-type-2').inputValue()).toBe('boolean');
    expect(await page.locator('#wf-var-optional-0').isChecked()).toBe(false);
    expect(await page.locator('#wf-var-when-field-0').isHidden()).toBe(true);
    expect(await page.locator('#wf-var-when-1').inputValue()).toBe('skip');
    expect(await page.locator('#wf-var-when-2').inputValue()).toBe('useRecorded');
    for (const label of [COPY_EDITOR.nameLabel, COPY_EDITOR.typeLabel, COPY_EDITOR.optionalLabel]) {
      expect(await page.getByLabel(label, { exact: true }).count()).toBe(3);
    }
    await page.locator('#wf-var-optional-0').check();
    expect(await page.locator('#wf-var-when-field-0').isVisible()).toBe(true);
    expect(await page.getByLabel(COPY_EDITOR.whenOmittedLabel, { exact: true }).count()).toBe(3);
    await page.locator('#wf-var-optional-0').uncheck();
    expect(await page.locator('#wf-var-when-field-0').isHidden()).toBe(true);
    // Clear Optional on "note", rename "order_id"
    await page.locator('#wf-var-optional-1').uncheck();
    expect(await page.locator('#wf-var-when-field-1').isHidden()).toBe(true);
    await page.locator('#wf-var-name-0').fill('order_number');
    await page.locator('#wf-inputs-save').click();
    await page.waitForFunction(() => document.querySelector('#wf-inputs-form') === null);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      id: A,
      variables: [
        { name: 'order_id', newName: 'order_number', type: 'string', optional: false },
        { name: 'note', newName: 'note', type: 'string', optional: false },
      ],
    });
    const saved = (await onDisk()).workflows[0];
    expect(saved.variables).toEqual([
      { name: 'order_number', type: 'string' },
      { name: 'note', type: 'string' },
      { name: 'urgent', type: 'boolean', optional: true },
    ]);
    expect(saved.steps[0].variable).toBe('order_number');
  });

  it('shows the rebuild note after an update that started one', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-rename').click();
    await page.locator('#wf-name-input').fill('Find orders');
    await page.unroute('**/api/workflows/update');
    await page.route('**/api/workflows/update', async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      await json(route, 200, { ...body, recompile: 'started' });
    });
    await page.locator('#wf-rename-save').click();
    await page.waitForSelector('.wf-notice');
    expect(await visibleText('.wf-notice')).toBe(COPY_EDITOR.rebuilding);
  });

  it('keeps the inputs form values when the answer is an error', async () => {
    await open(`#/workflows/${A}`);
    await page.locator('#wf-inputs').click();
    await page.locator('#wf-var-name-0').fill('9bad');
    await page.locator('#wf-inputs-save').click();
    await page.waitForFunction(() => (document.querySelector('#wf-inputs-error')?.textContent ?? '') !== '');
    expect(await page.locator('#wf-inputs-error').getAttribute('role')).toBe('alert');
    expect(await page.locator('#wf-var-name-0').inputValue()).toBe('9bad');
    expect((await onDisk()).workflows[0].variables[0].name).toBe('order_id');
  });

  describe('delete dialog', () => {
    it('opens with focus on Cancel, traps Tab, and sends nothing until Delete', async () => {
      await open(`#/workflows/${A}`);
      await page.locator('#wf-delete').click();
      const dialog = page.locator('[role="dialog"]');
      expect(await dialog.getAttribute('aria-modal')).toBe('true');
      expect(await dialog.innerText()).toContain('Find order');
      expect(await dialog.innerText()).toContain(COPY_EDITOR.deleteWarning);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete-cancel');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete-confirm');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete-cancel');
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete-confirm');
      expect(posts).toEqual([]);
    });

    it('closes with Escape or Cancel, returns focus to "Delete this action" and sends nothing', async () => {
      await open(`#/workflows/${A}`);
      await page.locator('#wf-delete').click();
      await page.keyboard.press('Escape');
      expect(await page.locator('[role="dialog"]').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete');
      await page.locator('#wf-delete').click();
      await page.locator('#wf-delete-cancel').click();
      expect(await page.locator('[role="dialog"]').count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('wf-delete');
      expect(posts).toEqual([]);
    });

    it('sends { id } once, disables both buttons while pending, then opens the list without the action', async () => {
      await open(`#/workflows/${A}`);
      await page.locator('#wf-delete').click();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.unroute('**/api/workflows/delete');
      await page.route('**/api/workflows/delete', async (route) => {
        posts.push({ path: '/api/workflows/delete', body: JSON.parse(route.request().postData() ?? '{}') });
        await gate;
        await route.continue();
      });
      await page.locator('#wf-delete-confirm').click();
      expect(await page.locator('#wf-delete-confirm').isDisabled()).toBe(true);
      expect(await page.locator('#wf-delete-cancel').isDisabled()).toBe(true);
      await page.locator('#wf-delete-confirm').click({ force: true }).catch(() => undefined);
      release();
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      expect(posts).toEqual([{ path: '/api/workflows/delete', body: { id: A } }]);
      await page.waitForFunction(() => location.hash === '#/workflows');
      await page.waitForSelector('.wf-list');
      expect(await page.locator('.wf-list a').count()).toBe(1);
      expect(await page.locator('.wf-list a').innerText()).toContain('Open admin');
      await page.waitForFunction(() => document.getElementById('live')?.textContent === 'The action was deleted.');
      expect(await live()).toBe(COPY_EDITOR.deleted);
      expect((await onDisk()).workflows.map((w) => w.id)).toEqual([B]);
    });

    it('keeps the dialog open with the message for 404 and 409, and re-enables the buttons', async () => {
      await open(`#/workflows/${A}`);
      await page.locator('#wf-delete').click();
      for (const status of [404, 409]) {
        await answer('/api/workflows/delete', status, { error: `Gone ${status}` });
        await page.locator('#wf-delete-confirm').click();
        await page.waitForFunction((s) => document.querySelector('#wf-delete-error')?.textContent === `Gone ${s}`, status);
        expect(await page.locator('#wf-delete-error').getAttribute('role')).toBe('alert');
        expect(await page.locator('[role="dialog"] #wf-delete-error').count()).toBe(1);
        expect(await page.locator('#wf-delete-confirm').isEnabled()).toBe(true);
        expect(await page.locator('#wf-delete-cancel').isEnabled()).toBe(true);
      }
    });

    it('says the action was not deleted after a server error or no answer, keeping the dialog', async () => {
      await open(`#/workflows/${A}`);
      await page.locator('#wf-delete').click();
      await answer('/api/workflows/delete', 500, { error: 'internal error' });
      await page.locator('#wf-delete-confirm').click();
      await page.waitForFunction((t) => document.querySelector('#wf-delete-error')?.textContent === t, COPY_EDITOR.deleteNotSaved);
      await page.unroute('**/api/workflows/delete');
      await page.route('**/api/workflows/delete', (route) => route.abort());
      await page.locator('#wf-delete-confirm').click();
      await page.waitForFunction((t) => document.querySelector('#wf-delete-error')?.textContent === t, COPY_EDITOR.deleteNotSaved);
      expect(await page.locator('[role="dialog"]').count()).toBe(1);
      expect((await onDisk()).workflows).toHaveLength(2);
    });
  });

  it('uses plain language in every text of the controls, the forms and the dialog', async () => {
    for (const text of allEditorCopyTexts() as string[]) expect(text.match(BANNED), text).toBeNull();
    await open(`#/workflows/${A}`);
    await page.locator('#wf-rename').click();
    const renameText = await visibleText('#wf-rename-form');
    await page.locator('#wf-inputs').click();
    const inputsText = await visibleText('#wf-inputs-form');
    await page.locator('#wf-delete').click();
    const dialogText = await visibleText('[role="dialog"]');
    for (const text of [renameText, inputsText, dialogText]) expect(text.match(BANNED)).toBeNull();
  });
});
