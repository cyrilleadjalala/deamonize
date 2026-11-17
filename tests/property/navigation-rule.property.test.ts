import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 180000, hookTimeout: 120000 });
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { dropNavigationReads, isScreenNavigation } from '../../src/recorder/navigation-rule.js';
import { isWrite, selectRecipe, type RecipeCandidate } from '../../src/recorder/select-recipe.js';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { SAMPLE_WEB_SET } from '../../src/studio/sample-data.js';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const VARS = ['a', 'b', 'c'];

interface Attempt extends RecipeCandidate {
  idx: number;
  request: { method: string; url: string };
}

const attemptsArb = fc
  .array(
    fc.record({
      method: fc.constantFrom(...METHODS),
      bound: fc.subarray(VARS),
      hasRecipe: fc.boolean(),
      path: fc.constantFrom('/api/a', '/api/b', '/api/c'),
    }),
    { maxLength: 8 },
  )
  .map((list): Attempt[] =>
    list.map((x, idx) => ({
      idx,
      bound: x.bound,
      request: { method: x.method, url: `https://app.test${x.path}` },
      ...(x.hasRecipe ? { recipe: { method: x.method } } : {}),
    })),
  );

const isRead = (a: Attempt): boolean => !isWrite(a.request.method);

describe('studio-first-recording-fixes: navigation rule (pure)', () => {
  // Feature: studio-first-recording-fixes, Property 8: Bug Condition - A navigation click does not take a mount read as its recipe
  it('Property 8: a screen navigation with no variable drops every read and keeps every write, in order', () => {
    fc.assert(
      fc.property(attemptsArb, (attempts) => {
        const { kept, dropped } = dropNavigationReads(attempts, { screenNavigation: true, used: [] });
        expect(kept.some(isRead)).toBe(false);
        expect(dropped.every(isRead)).toBe(true);
        expect(kept).toEqual(attempts.filter((a) => !isRead(a)));
        expect(dropped).toEqual(attempts.filter(isRead));
        expect([...kept, ...dropped].sort((x, y) => x.idx - y.idx)).toEqual(attempts);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: studio-first-recording-fixes, Property 9: Preservation - Other recipe selection is unchanged
  it('Property 9: attempts are unchanged when it is not a navigation or a variable is carried', () => {
    fc.assert(
      fc.property(attemptsArb, fc.subarray(VARS), fc.boolean(), fc.boolean(), (attempts, used, screenNavigation, submit) => {
        fc.pre(!screenNavigation || used.length > 0);
        const { kept, dropped } = dropNavigationReads(attempts, { screenNavigation, used });
        expect(dropped).toEqual([]);
        expect(kept).toEqual(attempts);
        expect(selectRecipe(kept, { submit, used })).toEqual(selectRecipe(attempts, { submit, used }));
      }),
      { numRuns: 200 },
    );
  });

  // Feature: studio-first-recording-fixes, Property 9: Preservation - Other recipe selection is unchanged
  it('Property 9: isScreenNavigation is false for non-click, submit and same-route inputs', () => {
    const routeArb = fc.constantFrom('/', '/clients', '/clients/', '/orders');
    const queryArb = fc.constantFrom('', '?q=1', '?q=2', '#top');
    fc.assert(
      fc.property(
        fc.constantFrom('type', 'select', 'keypress', 'hover', 'scrollIntoView'),
        routeArb,
        routeArb,
        queryArb,
        queryArb,
        (actionType, from, to, q1, q2) => {
          const nav = { from: `https://app.test${from}${q1}`, to: `https://app.test${to}${q2}` };
          expect(isScreenNavigation({ actionType, submit: false, nav })).toBe(false);
          expect(isScreenNavigation({ actionType: 'click', submit: true, nav })).toBe(false);
          const same = { from: `https://app.test${from}${q1}`, to: `https://app.test${from}${q2}` };
          expect(isScreenNavigation({ actionType: 'click', submit: false, nav: same })).toBe(false);
          expect(isScreenNavigation({ actionType: 'click', submit: false })).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Studio rendering properties (real Chromium; the API answers are rewritten in the browser to feed the new fields)

const idOf = (label: string): string => SAMPLE_WEB_SET.workflows.find((w) => w.label === label)!.id;
const CREATE = idOf('Create customer');
const SEARCH = idOf('Search customers');

interface WriteStep {
  index: number;
  label: string;
  risk: 'write' | 'delete';
  kind: 'login' | 'action';
}

const writeStepsArb = fc
  .array(
    fc.record({
      label: fc.stringMatching(/^Zq[a-z]{4,10}$/),
      risk: fc.constantFrom<'write' | 'delete'>('write', 'delete'),
    }),
    { minLength: 1, maxLength: 4 },
  )
  .chain((items) =>
    fc.tuple(fc.boolean(), fc.uniqueArray(fc.integer({ min: 0, max: 30 }), { minLength: items.length, maxLength: items.length })).map(
      ([firstIsLogin, indexes]): WriteStep[] =>
        items.map((item, i) => ({
          index: [...indexes].sort((a, b) => a - b)[i],
          label: `${item.label}${i}`,
          risk: item.risk,
          kind: i === 0 && firstIsLogin ? 'login' : 'action',
        })),
    ),
  );

const summaryOf = (steps: WriteStep[]): 'none' | 'login-only' | 'actions' =>
  steps.length === 0 ? 'none' : steps.every((s) => s.kind === 'login') ? 'login-only' : 'actions';

describe('studio-first-recording-fixes: Studio write steps (rendering)', () => {
  let browser: Browser;
  let studio: StudioHandle;
  let page: Page;
  let base: string;
  let patch: { writeSteps?: WriteStep[]; writeSummary?: string } | undefined;

  beforeAll(async () => {
    studio = await startStudio({ sampleData: true });
    base = studio.url.replace(/\/\?token=.*$/, '');
    browser = await chromium.launch();
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.route('**/api/workflows', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (patch !== undefined) {
        for (const wf of body.workflows) if (wf.id === CREATE || wf.id === SEARCH) Object.assign(wf, patch);
      }
      await route.fulfill({ response: res, json: body });
    });
    await page.route('**/api/playground', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = await res.json();
      if (patch !== undefined) {
        for (const tool of body.tools ?? []) if (tool.name === 'create_customer') Object.assign(tool, patch);
      }
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(studio.url);
    await page.waitForSelector('main h1, main h2');
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await studio?.close();
  });

  const openWorkflow = async (id: string): Promise<string> => {
    await page.goto('about:blank');
    await page.goto(`${base}/#/workflows/${id}`);
    await page.waitForSelector('.wf-detail .timeline');
    return ((await page.locator('.wf-detail').textContent()) ?? '').replace(/\s+/g, ' ');
  };

  const openDialog = async (): Promise<string | undefined> => {
    await page.goto('about:blank');
    await page.goto(`${base}/#/playground?tool=create_customer`);
    await page.waitForSelector('[data-playground="ready"]');
    await page.waitForSelector('#pg-f-login');
    await page.fill('#pg-f-login', 'ada');
    await page.fill('#pg-f-name', 'Ada');
    await page.click('#pg-call');
    const dialog = page.locator('dialog.pg-dialog');
    await dialog.waitFor({ state: 'visible' });
    return ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ');
  };

  // Feature: studio-first-recording-fixes, Property 10: Bug Condition - Studio names the write steps and keeps variable names on one line (rendering)
  it('Property 10: the workflow note and the confirmation dialog list each write step by number and label', async () => {
    await fc.assert(
      fc.asyncProperty(writeStepsArb, async (writeSteps) => {
        patch = { writeSteps, writeSummary: summaryOf(writeSteps) };
        const view = await openWorkflow(CREATE);
        const dialog = await openDialog();
        for (const text of [view, dialog ?? '']) {
          for (const s of writeSteps) {
            expect(text, `step ${s.index + 1} ${s.label}`).toContain(`Step ${s.index + 1}: ${s.label}`);
          }
          if (writeSteps.some((s) => s.kind === 'login')) expect(text).toContain('login form');
        }
      }),
      { numRuns: 4 },
    );
  });

  // Feature: studio-first-recording-fixes, Property 11: Preservation - Read-only tools and the confirmation flow are unchanged (UI)
  it('Property 11: a read-only workflow shows no write note, a read tool runs with no dialog, and a tool without writeSteps keeps the generic dialog', async () => {
    const readOnlyPatches = [undefined, { writeSteps: [], writeSummary: 'none' }, { writeSummary: 'none' }];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...readOnlyPatches), async (chosen) => {
        patch = chosen as typeof patch;
        const view = await openWorkflow(SEARCH);
        expect(view).not.toMatch(/Writes data|only write is the login form|login form/);

        // A read tool runs without a dialog
        await page.goto('about:blank');
        await page.goto(`${base}/#/playground?tool=search_customers`);
        await page.waitForSelector('#pg-f-query');
        await page.fill('#pg-f-query', 'Ada');
        await page.click('#pg-call');
        await page.waitForSelector('section.pg-result');
        expect(await page.locator('dialog.pg-dialog').count()).toBe(0);

        // A write tool with no writeSteps keeps the generic sentence. The sample server now sends real write
        // steps, so remove them to stand for a server that does not send the fields (undefined keys are
        // dropped when the patched response is serialised).
        patch = chosen === undefined ? { writeSteps: undefined, writeSummary: undefined } : { writeSummary: 'none' };
        const dialog = await openDialog();
        expect(dialog).toContain('This tool can change data in the real application.');
        expect(dialog).not.toMatch(/Step \d+:/);
      }),
      { numRuns: 3 },
    );
  });
});
