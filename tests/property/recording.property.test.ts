import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 });
import fc from 'fast-check';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { completeRecording, type CompletionContext, type CompletionHooks } from '../../src/cli/commands/record.js';
import { saveWorkflow } from '../../src/cli/commands/save-workflow.js';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { ScreenContent } from '../../src/types.js';

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

// ---------------------------------------------------------------------------------------------------------------
// Property 5 (offer part): the offer is the last typed field of the current route
// ---------------------------------------------------------------------------------------------------------------

type OfferEvent =
  | { t: 'typed'; fieldId: string; stale: boolean }
  | { t: 'row'; fieldId: string; stale: boolean }
  | { t: 'input'; fieldId: string }
  | { t: 'route'; route: string };

const fieldId = fc.constantFrom('a', 'b', 'c');
const offerEvent: fc.Arbitrary<OfferEvent> = fc.oneof(
  fc.record({ t: fc.constant('typed' as const), fieldId, stale: fc.boolean() }),
  fc.record({ t: fc.constant('row' as const), fieldId: fc.constantFrom('row:x', 'row:y'), stale: fc.boolean() }),
  fc.record({ t: fc.constant('input' as const), fieldId }),
  fc.record({ t: fc.constant('route' as const), route: fc.constantFrom('/a', '/b', '/c') }),
);

/** The offer a sequence must leave, stated from the sequence alone. */
function expectedOffer(events: OfferEvent[]): string | undefined {
  let current = '/a';
  let last: { index: number; fieldId: string } | undefined;
  events.forEach((e, index) => {
    if (e.t === 'route') current = e.route;
    else if ((e.t === 'typed' || e.t === 'row') && !e.stale) last = { index, fieldId: e.fieldId };
  });
  void current;
  if (last === undefined) return undefined;
  const after = events.slice(last.index + 1);
  const cleared = after.some((e) => e.t === 'route' || (e.t === 'input' && e.fieldId !== last!.fieldId));
  return cleared ? undefined : last.fieldId;
}

describe('recording properties (real browser)', () => {
  let browser: Browser;
  let httpServer: Server;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    httpServer = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><html><head><title>Fixed</title></head><body>
        <label for="q">Query</label><input id="q" type="text" />
        <label for="plan">Plan</label><select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
        <button type="button" id="add">Add</button>
        <ul id="items"></ul>
        <script>document.getElementById('add').addEventListener('click', () => { document.getElementById('items').appendChild(document.createElement('li')).textContent = 'x'; });</script>
      </body></html>`);
    });
    await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    dir = await mkdtemp(join(tmpdir(), 'daemonize-prop-'));
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => httpServer?.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });

  // Feature: studio-first-recording-fixes, Property 5: Bug Condition - The recording panel, the offer, the live flush and the finish binding
  it('Property 5: the offer is the last typed field unless a later route or another field cleared it', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl);
      await page.evaluate(() => (window as any).__daemonizeInstalled = undefined);
      const { CAPTURE_SCRIPT } = await import('../../src/recorder/capture-script.js');
      await page.evaluate(CAPTURE_SCRIPT);
      await fc.assert(
        fc.asyncProperty(fc.array(offerEvent, { maxLength: 12 }), async (events) => {
          const actual = await page.evaluate((list) => {
            const model = (window as any).__daemonizeHelpers.offerModel.create('/a');
            for (const e of list) {
              if (e.t === 'typed' || e.t === 'row') {
                // A result that comes back for another route than the current one is the stale one
                model.apply({ t: e.t, fieldId: e.fieldId, stepIndex: 0, suggestion: 's', label: 'l', route: e.stale ? '/stale' : model.route });
              } else {
                model.apply(e);
              }
            }
            return model.offer === null ? undefined : model.offer.fieldId;
          }, events);
          expect(actual).toBe(expectedOffer(events));
        }),
        { numRuns: 150 },
      );
    } finally {
      await page.close();
    }
  });

  // Feature: studio-first-recording-fixes, Property 7: Preservation - Recorded steps and screens do not change
  it('Property 7: scripted interactions record the steps they always did, and the panel is not in the screen hash', async () => {
    type Op = { kind: 'click' } | { kind: 'type'; text: string } | { kind: 'select'; value: 'free' | 'pro' };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.constant<Op>({ kind: 'click' }),
      fc.record({ kind: fc.constant('type' as const), text: fc.stringMatching(/^[a-z]{1,6}$/) }),
      fc.record({ kind: fc.constant('select' as const), value: fc.constantFrom('free' as const, 'pro' as const) }),
    );
    await fc.assert(
      // Typing in the same field twice with no other step in between updates one step (Requirement 2.8), so the
      // sequences keep another step between two typed texts
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 4 }).filter((list) => list.every((o, i) => !(o.kind === 'type' && list[i - 1]?.kind === 'type'))), async (ops) => {
        const page = await browser.newPage();
        try {
          const recorder = new WorkflowRecorder('Fixed');
          const live = new LiveRecorder(page, recorder);
          await page.goto(baseUrl);
          await live.attach();

          // What the script of the user must record: clicks, a typed text once the field is left, a changed select
          const expected: string[] = [];
          let plan = 'free';
          let query = '';
          for (const o of ops) {
            if (o.kind === 'click') {
              await page.locator('#add').click();
              expected.push('click:');
            } else if (o.kind === 'type') {
              await page.locator('#q').click();
              await page.keyboard.press('Control+A');
              await page.keyboard.type(o.text);
              await page.keyboard.press('Tab'); // leaving the field records it
              if (o.text !== query) {
                // A select that keeps its value records nothing, so two typed texts can still meet with no step
                // between them: the recorder then updates the typed step instead of adding one (Requirement 2.8).
                // Seen with [type a, select free (already free), type b], which records only type:b.
                const last = expected.length - 1;
                if (last >= 0 && expected[last].startsWith('type:')) expected[last] = `type:${o.text}`;
                else expected.push(`type:${o.text}`);
              }
              query = o.text;
            } else {
              await page.locator('#plan').selectOption(o.value);
              if (o.value !== plan) expected.push(`select:${o.value}`);
              plan = o.value;
            }
          }
          await page.waitForTimeout(100);
          await live.idle();
          const steps = recorder.stepsSoFar();
          expect(steps.map((s) => `${s.actionType}:${s.value ?? ''}`)).toEqual(expected);
          expect(steps.every((s) => s.selectors.length > 0 && s.anchor !== undefined)).toBe(true);

          // The panel is not part of the screen hash
          const hash = (raw: string): string => new ScreenHasher().computeId({ type: 'dom', raw, normalized: raw, capturedAt: 0 } as ScreenContent);
          const withPanel = hash(await page.content());
          await page.evaluate(() => document.querySelector('[data-daemonize-panel]')?.remove());
          expect(hash(await page.content())).toBe(withPanel);
        } finally {
          await page.close();
        }
      }),
      { numRuns: 6 },
    );
  });

  // Feature: studio-first-recording-fixes, Property 7: Preservation - Recorded steps and screens do not change (with the panel)
  it('Property 7 (with panel): the panel is mounted while recording and the screen hash is the same without it', async () => {
    const page = await browser.newPage();
    try {
      const live = new LiveRecorder(page, new WorkflowRecorder('Fixed'));
      await page.goto(baseUrl);
      await live.attach();
      expect(await page.locator('[data-daemonize-panel]').count()).toBe(1);
      const hash = (raw: string): string => new ScreenHasher().computeId({ type: 'dom', raw, normalized: raw, capturedAt: 0 } as ScreenContent);
      const withPanel = hash(await page.content());
      await page.evaluate(() => document.querySelector('[data-daemonize-panel]')?.remove());
      expect(hash(await page.content())).toBe(withPanel);
    } finally {
      await page.close();
    }
  });
  // Feature: studio-first-recording-fixes, Property 6: Bug Condition - No recorded step is lost after the session ends
  it('Property 6: a failing stage after the session writes the recovery file with every step, or nothing when none', async () => {
    const stages = ['captureFinalScreen', 'readResultZone', 'finalizeNetwork', 'saveWorkflow', 'closedPageWithZone'] as const;
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...stages), fc.integer({ min: 0, max: 20 }), async (stage, n) => {
        const out = join(await mkdtemp(join(dir, 'p6-')), 'flow.workflows.json');
        const recorder = new WorkflowRecorder('Flow');
        for (let i = 0; i < n; i++) recorder.addStep({ actionType: 'click', selectors: [`#b${i}`], label: `click ${i}` });
        const hasZone = stage !== 'captureFinalScreen' && stage !== 'saveWorkflow' && stage !== 'finalizeNetwork' ? true : false;

        const hooks: CompletionHooks = {
          captureFinalScreen: async () => {
            if (stage === 'captureFinalScreen') throw new Error('screen failed');
            return { type: 'dom', raw: '<p>x</p>', normalized: '<p>x</p>', capturedAt: 0 };
          },
          readResultZone: async (_page, zone) => {
            if (stage === 'readResultZone') throw new Error('zone failed');
            return { ...zone, extractor: { kind: 'text' } as never };
          },
          finalizeNetwork: async () => {
            if (stage === 'finalizeNetwork') throw new Error('network failed');
            return [];
          },
          saveWorkflow: async (path, target, workflow) => {
            if (stage === 'saveWorkflow' && path === out) throw new Error('save failed');
            return saveWorkflow(path, target, workflow);
          },
        };
        const context: CompletionContext = {
          options: { out, ...(hasZone ? { resultZone: '#r' } : {}) },
          page: { isClosed: () => stage === 'closedPageWithZone' } as unknown as Page,
          live: { stepCount: n, idle: async () => { }, finalizeNetwork: async () => [], resultZone: undefined },
          recorder,
          target: { targetType: 'web', name: 'app', startUrl: 'http://x/' },
        };

        const failure = await completeRecording(context, hooks).then(() => undefined, (err: Error) => err);
        expect(failure).toBeInstanceOf(Error);
        const recovery = `${out}.recovery.json`;
        if (n === 0) {
          expect(await exists(recovery)).toBe(false);
          expect(await exists(out)).toBe(false);
          return;
        }
        expect(failure!.message).toContain(recovery);
        expect(failure!.cause).toBeInstanceOf(Error);
        const set = deserializeWorkflowSet(await readFile(recovery, 'utf-8'));
        expect(set.workflows[0].steps).toHaveLength(n);
        if (hasZone) {
          expect(set.workflows[0].resultZone?.selector).toBe('#r');
          expect(set.workflows[0].resultZone?.schema).toBeUndefined();
        }
        expect(await exists(out)).toBe(false);
        expect((await readdir(join(out, '..'))).filter((f) => f.endsWith('.recovery.json'))).toHaveLength(1);
      }),
      { numRuns: 40 },
    );
  });
});
