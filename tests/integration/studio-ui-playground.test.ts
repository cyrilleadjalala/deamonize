import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { compile } from '../../src/cli/commands/compile.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { CONTRAST_AUDIT, NAME_AUDIT, type ContrastFailure } from '../helpers/browser-audits.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const greeter = join(workspaceRoot, 'tests', 'fixtures', 'greeter.mjs');

const steps = (risk: 'read' | 'write') => [
  { actionType: 'type' as const, selectors: [], variable: 'your_name', label: 'Type at "Your name"' },
  { actionType: 'keypress' as const, selectors: [], value: 'Enter' },
  { actionType: 'type' as const, selectors: [], value: '1' },
  { actionType: 'keypress' as const, selectors: [], value: 'Enter', risk },
];

const set: WorkflowSet = {
  version: '1',
  targetType: 'tui',
  targetName: 'Greeter',
  startCommand: [process.execPath, greeter],
  workflows: [
    { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'Greet someone', steps: steps('read'), variables: [{ name: 'your_name', description: 'Your name' }], observedPayloads: [{ your_name: 'Ada' }] },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', label: 'Greet and save', steps: steps('write'), variables: [{ name: 'your_name', description: 'Your name' }], observedPayloads: [{ your_name: 'Ada' }] },
  ],
};

interface Problems {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
}

function watch(page: Page): Problems {
  const problems: Problems = { console: [], pageErrors: [], failedRequests: [], badResponses: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.console.push(`${m.type()}: ${m.text()}`);
    else if (/content security policy/i.test(m.text())) problems.console.push(`csp: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.pageErrors.push(e.message));
  page.on('requestfailed', (r) => {
    // An aborted call is the point of one test
    // A navigation cancels the reads of the connect card that were still in flight
    if (!/\/api\/playground\/call$/.test(r.url()) && !(/\/api\/power\//.test(r.url()) && /ERR_ABORTED/.test(r.failure()?.errorText ?? ''))) problems.failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !(r.status() === 409 && r.url().endsWith('/api/playground/call'))) problems.badResponses.push(`${r.status()} ${r.url()}`);
  });
  return problems;
}

/** Auto-retrying assertions on a locator (the repo has no @playwright/test). */
function see(locator: Locator, message?: string) {
  const poll = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 15000, message });
  const texts = () => locator.allTextContents().then((all) => all.join('\n'));
  return {
    toHaveCount: (n: number) => poll(() => locator.count()).toBe(n),
    toContainText: (sub: string) => poll(texts).toContain(sub),
    notToContainText: (sub: string) => poll(texts).not.toContain(sub),
    toBeVisible: () => poll(() => locator.first().isVisible()).toBe(true),
    toBeHidden: () => poll(() => locator.first().isVisible()).toBe(false),
    toHaveAttribute: (name: string, want: string) => poll(() => locator.first().getAttribute(name)).toBe(want),
    toBeFocused: () => poll(() => locator.first().evaluate((el) => el === document.activeElement)).toBe(true),
  };
}

async function open(page: Page, base: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`${base}/#/playground`);
  await page.waitForFunction(() => document.querySelector('main[aria-busy]') === null && document.querySelector('main .loading') === null);
  await page.waitForSelector('[data-playground]');
}

async function audit(page: Page, label: string): Promise<void> {
  const names = (await page.evaluate(NAME_AUDIT)) as { unnamed: string[]; noAlt: string[]; badLabels: string[]; duplicateIds: string[] };
  expect(names, `${label} names`).toEqual({ unnamed: [], noAlt: [], badLabels: [], duplicateIds: [] });
  // Buttons fade between states (0.15 s): measure the settled colours, not a frame of the fade
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))));
  const contrast = (await page.evaluate(CONTRAST_AUDIT)) as { checked: number; failures: ContrastFailure[] };
  expect(contrast.checked, `${label} checked`).toBeGreaterThan(10);
  expect(contrast.failures, `${label} contrast`).toEqual([]);
}

describe('Studio playground UI, real server and real Chromium', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let problems: Problems;
  let dir: string;
  let handle: StudioHandle;
  let base: string;
  const calls: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(workspaceRoot, '.pg-ui-'));
    const file = join(dir, 'workflows.json');
    await writeFile(file, serializeWorkflowSet(set));
    const out = join(dir, 'out');
    const log = console.log;
    console.log = () => { };
    try {
      await compile(file, out);
    } finally {
      console.log = log;
    }
    handle = await startStudio({ workflowFile: file, outDir: out });
    base = handle.origin;
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        const w = window as unknown as { __csp?: string[] };
        (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    problems = watch(page);
    page.on('request', (r) => {
      if (r.url().endsWith('/api/playground/call')) calls.push(r.postDataJSON() as Record<string, unknown>);
    });
    await page.goto(handle.url);
    await page.waitForSelector('main h1, main h2');
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    if (dir) await removeDir(dir);
  });

  it('builds the form of a tool from its input schema, with required markers and descriptions', async () => {
    await open(page, base);
    await see(page.locator('[data-playground="ready"]')).toBeVisible();
    await see(page.locator('button.pg-tool')).toHaveCount(2);
    await see(page.locator('button.pg-tool[data-tool="greet_someone"]')).toHaveAttribute('aria-current', 'true');
    await see(page.locator('#pg-tool-title')).toContainText('greet_someone');
    const field = page.locator('.pg-field[data-field="your_name"]');
    await see(field.locator('label')).toContainText('your_name');
    await see(field.locator('label .chip.required')).toContainText('required');
    await see(field).toContainText('Your name');
    expect(await page.locator('#pg-f-your_name').getAttribute('aria-required')).toBe('true');
    expect(await page.locator('#pg-f-your_name').getAttribute('type')).toBe('text');
    await see(page.locator('.pg-field[data-field="_timeoutMs"] label')).toContainText('optional');
    await see(page.locator('#pg-server-state')).toContainText('Server running');
    // Strict only: there is no mode toggle without heal support
    await see(page.locator('.pg-status')).toContainText('Strict mode only');
    await see(page.locator('.pg-mode button')).toHaveCount(0);
  });

  it('checks required values in the form without calling the server', async () => {
    const before = calls.length;
    await page.click('#pg-call');
    await see(page.locator('.pg-field[data-field="your_name"] .error-text')).toContainText('required');
    await see(page.locator('#pg-f-your_name')).toBeFocused();
    expect(await page.locator('#pg-f-your_name').getAttribute('aria-invalid')).toBe('true');
    await page.fill('#pg-timeout', '0');
    await page.fill('#pg-f-your_name', 'x');
    await page.click('#pg-call');
    await see(page.locator('#pg-timeout-err')).toContainText('1 to 600000');
    expect(calls.length).toBe(before);
    await page.fill('#pg-timeout', '');
  });

  it('calls the tool and shows the result with its badges, the screen and the JSON', async () => {
    await page.fill('#pg-f-your_name', 'Ada');
    await page.click('#pg-call');
    const result = page.locator('section.pg-result[data-result="success"]');
    await see(result).toBeVisible();
    await see(result.locator('.pg-badges')).toContainText('Success');
    await see(result.locator('.pg-badges')).toContainText('Drift not checked');
    await see(result.locator('.pg-badges')).toContainText('Terminal screen');
    await see(result.locator('.pg-term')).toContainText('Hello Ada!');
    await see(result.locator('.pg-term')).toHaveAttribute('aria-label', 'Rendered terminal screen');
    await page.click('.pg-json summary');
    await see(result.locator('.pg-json pre')).toContainText('"success": true');
    expect(calls[calls.length - 1]).toMatchObject({ tool: 'greet_someone', arguments: { your_name: 'Ada' }, mode: 'strict' });
    expect(calls[calls.length - 1]).not.toHaveProperty('confirm');
    await see(page.locator('.pg-history tbody tr')).toHaveCount(1);
    await see(page.locator('.pg-history')).toContainText('greet_someone');
    await see(page.locator('#pg-call')).toBeVisible();
  });

  it('asks for confirmation before a write tool runs, in an accessible dialog', async () => {
    await page.click('button.pg-tool[data-tool="greet_and_save"]');
    await see(page.locator('.pg-head')).toContainText('greet_and_save');
    await see(page.locator('.pg-head .badge.risk[data-risk="write"]')).toHaveCount(1);
    await page.fill('#pg-f-your_name', 'Bob');
    const before = calls.length;
    await page.click('#pg-call');
    const dialog = page.getByRole('dialog', { name: 'Run greet_and_save?' });
    await see(dialog).toBeVisible();
    await see(dialog).toContainText('can change data');
    await see(page.locator('#pg-confirm-cancel')).toBeFocused();
    // The page behind is inert while it is open
    await page.keyboard.press('Escape');
    await see(page.locator('dialog.pg-dialog')).toHaveCount(0);
    await see(page.locator('#pg-call')).toBeFocused();
    expect(calls.length).toBe(before);
    // Confirm
    await page.click('#pg-call');
    await see(dialog).toBeVisible();
    await page.click('#pg-confirm-ok');
    await see(page.locator('section.pg-result[data-result="success"] .pg-term')).toContainText('Hello Bob!');
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]).toMatchObject({ tool: 'greet_and_save', confirm: true });
  });

  it('can abort a running call, and the next call works', async () => {
    await page.click('button.pg-tool[data-tool="greet_someone"]');
    await page.fill('#pg-f-your_name', 'Slow');
    await page.click('#pg-call');
    await see(page.locator('#pg-abort')).toBeVisible();
    await see(page.locator('.pg-running')).toContainText('Calling the tool');
    await page.click('#pg-abort');
    await see(page.locator('section.pg-result [data-bridge="aborted"]')).toContainText('cancelled');
    await see(page.locator('#pg-abort')).toBeHidden();
    await page.click('#pg-call');
    await see(page.locator('section.pg-result[data-result="success"] .pg-term')).toContainText('Hello Slow!');
  });

  it('has named controls, readable contrast, no console error, CSP violation or failed request', async () => {
    await audit(page, 'playground with a result');
    expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
    expect(problems).toEqual({ console: [], pageErrors: [], failedRequests: [], badResponses: [] });
    await page.setViewportSize({ width: 900, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

describe('Studio playground UI, sample mode (simulated server)', () => {
  let browser: Browser;
  let page: Page;
  let problems: Problems;
  let sample: StudioHandle;
  let base: string;

  const pick = (tool: string) => page.click(`button.pg-tool[data-tool="${tool}"]`);

  beforeAll(async () => {
    sample = await startStudio({ sampleData: true });
    base = sample.origin;
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    problems = watch(page);
    await page.goto(sample.url);
    await page.waitForSelector('main h1, main h2');
    await open(page, base);
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await sample?.close();
  });

  it('lists the sample tools with their risk, and says the server is simulated', async () => {
    await see(page.locator('[data-playground="ready"]')).toHaveAttribute('data-simulated', 'true');
    await see(page.locator('.pg-status [data-simulated="true"]')).toContainText('Simulated server');
    await see(page.locator('button.pg-tool')).toHaveCount(4);
    await see(page.locator('button.pg-tool[data-tool="create_customer"] .badge.risk[data-risk="write"]')).toHaveCount(1);
    await see(page.locator('button.pg-tool[data-tool="search_customers"] .badge.risk[data-risk="read"]')).toHaveCount(1);
  });

  it('shows a drifted success with the levels used and the data', async () => {
    await pick('search_customers');
    await page.fill('#pg-f-query', 'drift');
    await page.click('#pg-call');
    const result = page.locator('section.pg-result[data-result="success"]');
    await see(result.locator('.pg-badges')).toContainText('Success');
    await see(result.locator('.pg-badges [data-flag="drifted"][data-value="true"]')).toContainText('Drifted');
    await see(result.locator('.pg-levels')).toContainText('API / HTTP');
    await see(result.locator('.pg-title')).toContainText('Customers (new layout)');
    await see(result).toContainText('Mode: strict');
    // No match for the name: no data rows, not drifted
    await page.fill('#pg-f-query', 'Ada');
    await page.click('#pg-call');
    await see(page.locator('.pg-badges [data-flag="drifted"][data-value="false"]')).toContainText('Not drifted');
    await see(page.locator('.pg-screen pre.pg-text')).toContainText('Ada Lovelace');
  });

  it('confirms a write tool, then shows the failure diagnostics and the screenshot', async () => {
    await pick('create_customer');
    await see(page.locator('.pg-secrets')).toContainText('CRM_PASSWORD');
    await see(page.locator('.pg-secrets')).toContainText('Its value is never shown');
    expect(await page.locator('#pg-f-crm_password').count()).toBe(0);
    await page.fill('#pg-f-login', 'ada');
    await page.fill('#pg-f-name', 'fail');
    await page.click('#pg-call');
    await see(page.getByRole('dialog', { name: 'Run create_customer?' })).toBeVisible();
    await page.click('#pg-confirm-ok');
    const result = page.locator('section.pg-result[data-result="failed"]');
    await see(result.locator('.pg-badges')).toContainText('Failed');
    await see(result.locator('.pg-failure')).toContainText('Step');
    await see(result.locator('.pg-failure')).toContainText('role=button[name="Save"]');
    await see(result.locator('.pg-failure')).toContainText('not in the dialog any more');
    const img = result.locator('.pg-shot img');
    await see(img).toHaveCount(1);
    await page.waitForFunction(() => (document.querySelector('.pg-shot img') as HTMLImageElement | null)?.complete === true);
    expect(await img.getAttribute('alt')).toMatch(/Screenshot of the page at the failing step/);
    expect(await img.getAttribute('src')).toMatch(/^\/api\/playground\/shot\/[a-f0-9]{24}\.png$/);
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  it('switches to heal mode (restarting the server) and heals the chart call', async () => {
    await pick('open_sales_chart');
    await page.click('#pg-call');
    await see(page.locator('section.pg-result[data-result="failed"] .pg-failure')).toContainText('canvas');
    const heal = page.locator('.pg-mode button[data-mode="heal"]');
    await see(heal).toHaveAttribute('aria-pressed', 'false');
    await heal.click();
    await see(heal).toHaveAttribute('aria-pressed', 'true');
    await see(page.locator('#pg-mode-note')).toContainText('Mode is now heal');
    await page.click('#pg-call');
    const result = page.locator('section.pg-result[data-result="success"]');
    await see(result.locator('.pg-badges [data-flag="healed"][data-value="true"]')).toContainText('Healed 1 step');
    await see(result).toContainText('Mode: heal');
    await see(result.locator('.pg-levels')).toContainText('Coordinates');
    await page.click('.pg-mode button[data-mode="strict"]');
    await see(page.locator('#pg-mode-note')).toContainText('Mode is now strict');
  });

  it('asks for a screenshot of the final screen and shows a terminal screen in a monospace panel', async () => {
    await pick('open_sales_chart');
    await page.click('.pg-mode button[data-mode="heal"]');
    await see(page.locator('#pg-mode-note')).toContainText('Mode is now heal');
    await page.check('#pg-preview');
    await page.click('#pg-call');
    await see(page.locator('section.pg-result[data-result="success"] .pg-shot img')).toHaveCount(1);
    await see(page.locator('.pg-shot figcaption')).toContainText('Final screen');
    await pick('count_customers_in_a_table');
    await page.fill('#pg-f-table', 'customers');
    await page.click('#pg-call');
    await see(page.locator('section.pg-result .pg-term')).toContainText('sqlite> select count(*) from customers;');
    await see(page.locator('.pg-badges')).toContainText('Terminal screen');
  });

  it('keeps the history of the session with the arguments shown', async () => {
    expect(await page.locator('.pg-history tbody tr').count()).toBeGreaterThanOrEqual(5);
    await see(page.locator('.pg-history')).toContainText('search_customers');
    await see(page.locator('.pg-history')).toContainText('drifted');
  });

  it('has named controls, readable contrast, no console error, CSP violation or failed request', async () => {
    await audit(page, 'sample playground');
    expect(problems).toEqual({ console: [], pageErrors: [], failedRequests: [], badResponses: [] });
  });
});

describe('Studio playground confirmation dialog lists the write steps (sample mode)', () => {
  let browser: Browser;
  let page: Page;
  let sample: StudioHandle;
  let base: string;
  let writeInfo: Record<string, unknown> | undefined;

  const askConfirmation = async (): Promise<string> => {
    await open(page, base);
    await page.click('button.pg-tool[data-tool="create_customer"]');
    await page.fill('#pg-f-login', 'ada');
    await page.fill('#pg-f-name', 'Ada');
    await page.click('#pg-call');
    const dialog = page.getByRole('dialog', { name: 'Run create_customer?' });
    await see(dialog).toBeVisible();
    return ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ');
  };

  beforeAll(async () => {
    sample = await startStudio({ sampleData: true });
    base = sample.origin;
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.route('**/api/playground', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      for (const tool of body.tools ?? []) if (tool.name === 'create_customer' && writeInfo !== undefined) Object.assign(tool, writeInfo);
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(sample.url);
    await page.waitForSelector('main h1, main h2');
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await sample?.close();
  });

  // Feature: studio-first-recording-fixes, Property 10: Bug Condition - Studio names the write steps and keeps variable names on one line (rendering)
  it('says the only write is the login form for a login-only tool', async () => {
    writeInfo = { writeSummary: 'login-only', writeSteps: [{ index: 3, label: 'Submit sign-in', risk: 'write', kind: 'login' }] };
    const text = await askConfirmation();
    expect(text).toContain('login form');
    expect(text).toContain('Step 4');
    expect(text).toContain('Submit sign-in');
  });

  it('lists each write step of a tool with actions', async () => {
    writeInfo = {
      writeSummary: 'actions',
      writeSteps: [
        { index: 3, label: 'Submit sign-in', risk: 'write', kind: 'login' },
        { index: 6, label: 'Remove record', risk: 'delete', kind: 'action' },
      ],
    };
    const text = await askConfirmation();
    expect(text).toContain('Step 4: Submit sign-in');
    expect(text).toContain('Step 7: Remove record');
    expect(text).toContain('login form');
  });
});
