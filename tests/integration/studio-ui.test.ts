import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { SAMPLE_WEB_SET, SAMPLE_TUI_SET } from '../../src/studio/sample-data.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';
import { CONTRAST_AUDIT, NAME_AUDIT, type ContrastFailure } from '../helpers/browser-audits.js';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const idOf = (label: string): string => {
  const all = [...SAMPLE_WEB_SET.workflows, ...SAMPLE_TUI_SET.workflows];
  return all.find((w) => w.label === label)!.id;
};
const SEARCH = idOf('Search customers');
const CREATE = idOf('Create customer');
const CHART = idOf('Open sales chart');
const SQLITE = idOf('Count customers in a table');

const VIEWS = [
  { name: 'overview', hash: '#/', heading: 'Overview' },
  { name: 'workflows', hash: '#/workflows', heading: 'Workflows' },
  { name: 'workflow-detail', hash: `#/workflows/${CREATE}`, heading: 'Create customer' },
  { name: 'workflow-detail-terminal', hash: `#/workflows/${SQLITE}`, heading: 'Count customers in a table' },
  { name: 'graph', hash: '#/graph', heading: 'Graph' },
  { name: 'graph-highlight', hash: `#/graph?wf=${CREATE}`, heading: 'Graph' },
  { name: 'schemas', hash: `#/schemas/${CREATE}`, heading: 'Create customer' },
  { name: 'tests', hash: '#/tests', heading: 'Tests' },
  { name: 'playground', hash: '#/playground', heading: 'Playground' },
];

interface Problems {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  dialogs: string[];
}

/** Watch a page: console errors, uncaught errors, CSP violations, failed requests and error responses. */
function watch(page: Page): Problems {
  const problems: Problems = { console: [], pageErrors: [], failedRequests: [], badResponses: [], dialogs: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      // The playground probe is allowed to answer 404 until the playground exists (task 20.4)
      if (/\/api\/playground/.test(m.location().url ?? '')) return;
      problems.console.push(`${m.type()}: ${m.text()}`);
    } else if (/content security policy/i.test(m.text())) problems.console.push(`csp: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.pageErrors.push(e.message));
  page.on('requestfailed', (r) => problems.failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/api/playground')) problems.badResponses.push(`${r.status()} ${r.url()}`);
  });
  page.on('dialog', (d) => {
    problems.dialogs.push(d.message());
    void d.dismiss();
  });
  return problems;
}

/**
 * Auto-retrying assertions on a Playwright locator (the repo has no @playwright/test): each one polls the page
 * until it holds or 8 s pass.
 */
function see(locator: Locator, message?: string) {
  const poll = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 8000, message });
  const texts = () => locator.allTextContents().then((all) => all.join('\n'));
  const make = (negate: boolean) => {
    const check = <T>(read: () => Promise<T>) => (negate ? poll(read).not : poll(read));
    return {
      toHaveCount: (n: number) => check(() => locator.count()).toBe(n),
      toContainText: (sub: string) => check(texts).toContain(sub),
      toHaveText: (want: string | string[]) =>
        Array.isArray(want) ? check(() => locator.allTextContents().then((a) => a.map((t) => t.trim()))).toEqual(want) : check(() => locator.first().textContent().then((t) => (t ?? '').trim())).toBe(want),
      toHaveAttribute: (name: string, want: string | RegExp) =>
        want instanceof RegExp ? check(() => locator.first().getAttribute(name).then((v) => v ?? '')).toMatch(want) : check(() => locator.first().getAttribute(name)).toBe(want),
      toBeVisible: () => check(() => locator.first().isVisible()).toBe(true),
      toBeHidden: () => check(() => locator.first().isVisible()).toBe(false),
      toBeEnabled: () => check(() => locator.first().isEnabled()).toBe(true),
      toBeDisabled: () => check(() => locator.first().isDisabled()).toBe(true),
      toBeFocused: () => check(() => locator.first().evaluate((el) => el === document.activeElement)).toBe(true),
    };
  };
  return { ...make(false), not: make(true) };
}

const clean = (p: Problems) => ({ ...p });
const NONE: Problems = { console: [], pageErrors: [], failedRequests: [], badResponses: [], dialogs: [] };

async function ready(page: Page): Promise<void> {
  await page.waitForSelector('main h1, main h2', { state: 'visible' });
  await page.waitForFunction(() => document.querySelector('main[aria-busy]') === null);
}

async function go(page: Page, base: string, hash: string): Promise<void> {
  // A full load each time: a hash change alone could be mistaken for the previous, still visible, view
  await page.goto('about:blank');
  await page.goto(`${base}/${hash}`);
  await page.waitForFunction(() => document.querySelector('main[aria-busy]') === null && document.querySelector('main .loading') === null);
  await ready(page);
}

describe('Studio UI (real Chromium, sample data)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let problems: Problems;
  let sample: StudioHandle;
  let base: string;

  beforeAll(async () => {
    sample = await startStudio({ sampleData: true });
    base = sample.url.replace(/\/\?token=.*$/, '');
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        const w = window as unknown as { __csp?: string[] };
        (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    problems = watch(page);
    // The first visit carries the token and leaves it in a cookie
    await page.goto(sample.url);
    await ready(page);
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await sample?.close();
  });

  const cspViolations = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

  it('serves the real UI, not the placeholder', async () => {
    await go(page, base, '#/');
    await see(page.locator('header .brand-name')).toContainText('Daemonize');
    await see(page.locator('header .logo')).toHaveCount(1);
    await see(page.locator('#sample-banner')).toBeVisible();
    await see(page.locator('#sample-banner')).toContainText('Sample data');
  });

  it('renders every view without console errors, CSP violations or failed requests', async () => {
    for (const v of VIEWS) {
      await go(page, base, v.hash);
      await see(page.locator('main h1, main h2'), v.name).toContainText(v.heading);
      expect(await cspViolations(), `${v.name} csp`).toEqual([]);
      // No unhandled rejections or half-drawn view
      await see(page.locator('main .state.error'), v.name).toHaveCount(0);
    }
    expect(clean(problems)).toEqual(NONE);
  });

  it('shows the overview: target cards, level mix, mode flags and the health strip', async () => {
    await go(page, base, '#/');
    await see(page.locator('.target-card')).toHaveCount(2);
    const web = page.locator('.target-card[data-type="web"]');
    await see(web).toContainText('Legacy CRM (sample)');
    await see(web.locator('.stackbar .seg')).not.toHaveCount(0);
    await see(web.locator('.stackbar')).toHaveAttribute('aria-label', /API \/ HTTP/);
    await see(web.locator('.flag[data-on="true"]')).not.toHaveCount(0);
    const tui = page.locator('.target-card[data-type="tui"]');
    await see(tui.locator('.flag[data-flag="heal"]')).toHaveAttribute('data-on', 'false');
    await see(page.locator('.health')).toContainText('Property tests');
    await see(page.locator('.health')).toContainText('Failing');
    await see(page.locator('.health .chip.secret')).toContainText('CRM_PASSWORD');
  });

  it('shows a level badge on every step, for http, accessibility, vision, coordinates and terminal', async () => {
    const seen = new Set<string>();
    const primaryOf = async (id: string): Promise<string[]> => {
      await go(page, base, `#/workflows/${id}`);
      for (const level of await page.locator('.legend .badge.level').evaluateAll((els) => els.map((e) => e.getAttribute('data-level') ?? ''))) seen.add(`legend:${level}`);
      const steps = page.locator('.timeline > .step');
      const count = await steps.count();
      expect(await page.locator('.timeline > .step > .step-body .badge.level[data-primary="true"]').count(), 'one primary badge per step').toBe(count);
      for (const level of await page.locator('.timeline .badge.level').evaluateAll((els) => els.map((e) => e.getAttribute('data-level') ?? ''))) seen.add(level);
      return steps.evaluateAll((els) => els.map((e) => e.getAttribute('data-level') ?? ''));
    };
    expect(await primaryOf(SEARCH)).toEqual(['http', 'accessibility']);
    expect(await primaryOf(CHART)).toEqual(['accessibility', 'vision']);
    expect((await primaryOf(CREATE)).every((l) => l === 'accessibility')).toBe(true);
    expect(await primaryOf(SQLITE)).toEqual(['terminal', 'terminal']);
    for (const level of ['http', 'accessibility', 'vision', 'coordinates', 'terminal']) expect(seen.has(level), level).toBe(true);
    for (const level of ['http', 'accessibility', 'vision', 'coordinates', 'terminal']) expect(seen.has(`legend:${level}`), `legend ${level}`).toBe(true);
  });

  it('shows step details: intent, context chips, variable chip, secrets, waits, thumbnails with alt text', async () => {
    await go(page, base, `#/workflows/${CREATE}`);
    await see(page.locator('.chip.variable', { hasText: '{{login}}' }).first()).toBeVisible();
    await see(page.locator('.chip.parent', { hasText: 'New customer' }).first()).toBeVisible();
    await see(page.locator('.step[data-risk="write"]')).toHaveCount(1);
    await see(page.locator('section[aria-labelledby="p-secrets"] .chip.secret')).toHaveText('CRM_PASSWORD');
    await see(page.locator('section[aria-labelledby="p-vars"] tbody tr')).toHaveCount(3);
    await see(page.locator('section[aria-labelledby="p-vars"]')).toContainText('optional');
    await go(page, base, `#/workflows/${SEARCH}`);
    const img = page.locator('.thumb img');
    await see(img).toHaveCount(1);
    expect(await img.getAttribute('alt')).toMatch(/Screenshot recorded at step 1/);
    await see(page.locator('.http-line')).toContainText('GET /api/customers');
    await go(page, base, `#/workflows/${SQLITE}`);
    await see(page.locator('.wait-line')).toContainText('sqlite> $');
    // Copyable tool name
    await see(page.getByRole('button', { name: 'Copy tool name count_customers_in_a_table' })).toBeVisible();
  });

  it('draws the graph with the expected nodes and highlights the path of a workflow', async () => {
    await go(page, base, '#/graph');
    await see(page.locator('.graph-svg .node')).toHaveCount(5);
    await see(page.locator('.graph-svg .edge')).toHaveCount(5);
    await see(page.locator('.graph-svg .node.on-path')).toHaveCount(0);
    await page.selectOption('#graph-wf', CREATE);
    await see(page.locator('.graph-svg .node.on-path')).toHaveCount(4);
    await see(page.locator('.graph-svg .edge.on-path')).toHaveCount(3);
    await see(page.locator('.graph-status')).toContainText('Create customer');
    await page.selectOption('#graph-wf', SEARCH);
    await see(page.locator('.graph-svg .node.on-path')).toHaveCount(2);
    await page.selectOption('#graph-wf', SQLITE);
    await see(page.locator('.graph-svg .node.on-path')).toHaveCount(0);
    await see(page.locator('.graph-status')).toContainText('not part of this graph');
    // Deep link
    await go(page, base, `#/graph?wf=${CHART}`);
    await see(page.locator('.graph-svg .node.on-path')).toHaveCount(3);
  });

  it('selects a screen into the focus panel and pans/zooms with the keyboard and the buttons', async () => {
    await go(page, base, '#/graph');
    const node = page.locator('.graph-svg .node[data-node="3333cccc4444dddd"]');
    await node.focus();
    await page.keyboard.press('Enter');
    await see(page.locator('.focus-panel')).toContainText('Customer created');
    await see(node).toHaveAttribute('aria-pressed', 'true');
    await see(page.locator('.focus-panel')).toContainText('Create customer'); // a workflow ending here
    const widthOf = async (): Promise<number> => Number((await page.locator('.graph-svg').getAttribute('viewBox'))!.split(' ')[2]);
    const before = await widthOf();
    await page.locator('.graph-canvas').focus();
    await page.keyboard.press('+');
    expect(await widthOf()).toBeLessThan(before);
    await page.keyboard.press('0');
    expect(await widthOf()).toBeCloseTo(before, 3);
    const x0 = Number((await page.locator('.graph-svg').getAttribute('viewBox'))!.split(' ')[0]);
    await page.keyboard.press('ArrowRight');
    expect(Number((await page.locator('.graph-svg').getAttribute('viewBox'))!.split(' ')[0])).toBeGreaterThan(x0);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    expect(await widthOf()).toBeLessThan(before);
    // Wheel zoom
    await page.locator('.graph-canvas').hover();
    const w1 = await widthOf();
    await page.mouse.wheel(0, -300);
    await expect.poll(widthOf).toBeLessThan(w1);
    // The list view is always there
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await see(page.locator('table[aria-label="Screens and transitions"] tbody tr')).toHaveCount(5);
  });

  it('supports keyboard navigation: skip link first, nav links, workflow list, Enter opens a workflow', async () => {
    await go(page, base, '#/workflows');
    // Document order is tab order (no positive tabindex): skip link, brand, the six tabs, then the content
    const tabbable = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, [tabindex="0"]')].filter((e) => !e.closest('[hidden]')).slice(0, 8).map((e) => e.id || e.textContent?.trim() || '')
    );
    expect(tabbable[0]).toBe('skip-link');
    expect(tabbable.slice(2)).toEqual(['Overview', 'Workflows', 'Graph', 'Schemas', 'Tests', 'Playground']);
    // After a navigation the heading holds focus; Tab continues from there into the list
    await see(page.locator('main h1')).toBeFocused();
    const order: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { cls: el?.className ?? '', text: el?.textContent?.trim().slice(0, 30) ?? '', id: el?.id ?? '' };
      });
      order.push(info.text || info.id);
      if (String(info.cls).includes('wf-link')) break;
    }
    expect(order[0]).toBe('wf-filter'); // the filter field comes before the list
    const focusedClass = await page.evaluate(() => document.activeElement?.className ?? '');
    expect(String(focusedClass)).toContain('wf-link');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('wf-link'))).toBe(true);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /^#\/workflows\/.+/.test(location.hash));
    await see(page.locator('main h2')).toBeFocused();
    await see(page.locator('.timeline')).toBeVisible();
    await see(page.locator('.wf-link[aria-current="page"]')).toHaveCount(1);
    // The visible focus ring: a keyboard-focused link has an outline
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
    expect(outline).not.toBe('none');
  });

  it('shows schemas as a table with required and optional properties, a raw JSON toggle and copy', async () => {
    await go(page, base, `#/schemas/${CREATE}`);
    const input = page.locator('.schema-block[data-schema="input"]');
    await see(input.locator('thead th')).toHaveText(['Property', 'Type', 'Required', 'Format', 'Constraints', 'Description']);
    const row = (name: string) => input.locator('tbody tr', { has: page.locator(`th code:text-is("${name}")`) });
    await see(row('login')).toContainText('required');
    await see(row('name')).toContainText('required');
    await see(row('country')).toContainText('optional');
    await see(page.locator('.schema-block[data-schema="output"]')).toContainText('drifted');
    const toggle = input.getByRole('button', { name: 'Raw JSON' });
    await toggle.click();
    await see(toggle).toHaveAttribute('aria-pressed', 'true');
    await see(input.locator('pre')).toContainText('"properties"');
    await toggle.click();
    await see(input.locator('table')).toBeVisible();
    await see(input.getByRole('button', { name: 'Copy input as JSON' })).toBeVisible();
    await see(page.locator('main')).toContainText('POST');
    await see(page.locator('.panel', { hasText: 'OpenAPI' }).first().locator('tbody tr')).not.toHaveCount(0);
  });

  it('shows property test results with a shrunk counterexample and a disabled run button in sample mode', async () => {
    await go(page, base, '#/tests');
    await see(page.locator('.pbt-card')).toHaveCount(4);
    await see(page.locator('.pbt-card[data-tool="create_customer"]')).toHaveAttribute('data-status', 'fail');
    await see(page.locator('.pbt-card[data-tool="search_customers"]')).toHaveAttribute('data-status', 'pass');
    await see(page.locator('.counterexample')).toContainText('"name":""');
    await see(page.locator('#run-tests')).toBeDisabled();
    await see(page.locator('.run-status')).toContainText('Sample mode');
  });

  it('shows the simulated playground in sample mode', async () => {
    await go(page, base, '#/playground');
    await see(page.locator('[data-playground="ready"]')).toHaveAttribute('data-simulated', 'true');
    await see(page.locator('button.pg-tool')).toHaveCount(4);
  });

  it('keeps the playground route alive when the endpoint is absent', async () => {
    const off = await startStudio({ sampleData: true, playground: false });
    const other = await browser.newContext();
    try {
      const p = await other.newPage();
      await p.goto(off.url);
      await ready(p);
      await p.goto(`${off.origin}/#/playground`);
      await see(p.locator('[data-playground="absent"]')).toContainText('once the MCP playground is enabled');
    } finally {
      await other.close();
      await off.close();
    }
  });

  it('has no unnamed controls, no image without alt and readable contrast in every view', async () => {
    for (const v of VIEWS) {
      await go(page, base, v.hash);
      const names = (await page.evaluate(NAME_AUDIT)) as { unnamed: string[]; noAlt: string[]; badLabels: string[]; duplicateIds: string[] };
      expect(names, `${v.name} names`).toEqual({ unnamed: [], noAlt: [], badLabels: [], duplicateIds: [] });
      const contrast = (await page.evaluate(CONTRAST_AUDIT)) as { checked: number; failures: ContrastFailure[] };
      expect(contrast.checked, `${v.name} checked`).toBeGreaterThan(10);
      expect(contrast.failures, `${v.name} contrast`).toEqual([]);
    }
    // The graph labels are SVG text: check their fill against the node fill by hand
    await go(page, base, '#/graph');
    const svgPairs = await page.evaluate(() => {
      const node = document.querySelector('.graph-svg .node-box') as SVGElement;
      const label = document.querySelector('.graph-svg .node-label') as SVGElement;
      return { box: getComputedStyle(node).fill, text: getComputedStyle(label).fill };
    });
    expect(svgPairs.text).not.toBe(svgPairs.box);
  });

  it('keeps every view within the width at 900 px, and the print view free of controls', async () => {
    await page.setViewportSize({ width: 900, height: 700 });
    for (const v of VIEWS) {
      await go(page, base, v.hash);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${v.name} horizontal overflow`).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await go(page, base, `#/workflows/${CREATE}`);
    await page.emulateMedia({ media: 'print' });
    await see(page.locator('.main-nav')).toBeHidden();
    await see(page.locator('.timeline')).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
  });

  it('respects prefers-reduced-motion', async () => {
    const reduced = await browser.newContext({ reducedMotion: 'reduce' });
    const p = await reduced.newPage();
    await p.goto(sample.url);
    await ready(p);
    expect(await p.evaluate(() => getComputedStyle(document.querySelector('.logo') as Element).animationName)).toBe('none');
    await reduced.close();
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: no-preference)').matches)).toBe(true);
  });

  it('takes screenshots at 1280x720 only when STUDIO_SCREENSHOTS=1, and never fails because of them', async () => {
    if (process.env.STUDIO_SCREENSHOTS !== '1') return;
    try {
      const dir = join(workspaceRoot, 'tests', '__screenshots__');
      await mkdir(dir, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots: Array<[string, string, string?]> = [
        ['overview', '#/'],
        ['workflows', `#/workflows/${SEARCH}`],
        ['workflow-detail', `#/workflows/${CREATE}`],
        ['graph', `#/graph?wf=${CREATE}`],
        ['schemas', `#/schemas/${CREATE}`],
        ['tests', '#/tests'],
        ['playground', '#/playground'],
      ];
      for (const [name, hash] of shots) {
        await go(page, base, hash);
        await page.screenshot({ path: join(dir, `${name}.png`) });
      }
    } catch (err) {
      console.warn('Screenshots skipped:', (err as Error).message);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

const XSS_IMG = '<img src=x onerror=alert(1)>';
const XSS_SCRIPT = '<script>window.__xss=1</script>';
const XSS_ID = '99999999-9999-4999-8999-999999999999';

const hostile: WorkflowSet = {
  version: '1',
  targetType: 'web',
  targetName: XSS_IMG,
  startUrl: 'http://localhost:8080/',
  workflows: [
    {
      id: XSS_ID,
      label: XSS_IMG,
      steps: [
        {
          actionType: 'click',
          selectors: ['#go'],
          label: XSS_IMG,
          anchor: { role: 'button', name: XSS_IMG, parent: { kind: 'dialog', name: XSS_SCRIPT }, frame: [] },
          visual: { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, intent: `${XSS_IMG}` },
        },
      ],
      variables: [{ name: 'email', description: `${XSS_IMG} <img src=x onerror="window.__xss=1">` }],
      observedPayloads: [],
    },
  ],
};

describe('Studio UI against hostile data and a live (non-sample) server', () => {
  let dir: string;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;
  let problems: Problems;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(workspaceRoot, '.studio-ui-'));
    const file = join(dir, 'workflows.json');
    await writeFile(file, serializeWorkflowSet(hostile));
    studio = await startStudio({ workflowFile: file, outDir: join(dir, 'out'), env: {} });
    base = studio.url.replace(/\/\?token=.*$/, '');
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    problems = watch(page);
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', () => {
        (window as unknown as { __cspHit?: boolean }).__cspHit = true;
      });
    });
    await page.goto(studio.url);
    await ready(page);
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (dir) await removeDir(dir);
  });

  it('renders markup in labels as inert text in every view', async () => {
    for (const hash of ['#/', '#/workflows', `#/workflows/${XSS_ID}`, '#/graph', `#/graph?wf=${XSS_ID}`, `#/schemas/${XSS_ID}`, '#/tests']) {
      await go(page, base, hash);
      expect(await page.locator('main img').count(), `${hash} injected <img>`).toBe(0);
      expect(await page.locator('main script').count(), `${hash} injected <script>`).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), hash).toBeUndefined();
    }
    // The payload is visible, as text
    await go(page, base, '#/workflows');
    await see(page.locator('.wf-name').first()).toHaveText(XSS_IMG);
    await go(page, base, `#/workflows/${XSS_ID}`);
    await see(page.locator('main h2')).toHaveText(XSS_IMG);
    await see(page.locator('.chip.parent')).toContainText('<script>window.__xss=1</script>');
    await see(page.locator('section[aria-labelledby="p-vars"]')).toContainText(XSS_IMG);
    await see(page.locator('.intent')).toContainText(XSS_IMG);
    await go(page, base, `#/graph?wf=${XSS_ID}`);
    await see(page.locator('.graph-svg .node-label').first()).toContainText('<img');
    // No alert, no request for the picture "x", no uncaught error
    expect(problems.dialogs).toEqual([]);
    expect(problems.pageErrors).toEqual([]);
    expect(problems.badResponses.filter((r) => /\/x$/.test(r))).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __cspHit?: boolean }).__cspHit)).toBeUndefined();
  });

  it('reports a run that cannot happen as a result and an error, and re-enables the button', async () => {
    await go(page, base, '#/tests');
    const button = page.locator('#run-tests');
    await see(button).toBeEnabled();
    const post = page.waitForResponse((r) => r.url().endsWith('/api/pbt/run') && r.request().method() === 'POST');
    await button.click();
    expect((await post).status()).toBe(200);
    await see(button).toBeEnabled();
    await see(page.locator('.pbt-summary')).toContainText('did not run');
    await see(page.locator('.pbt-summary .error-text')).toContainText('tests folder');
  });
});
