// Feature: kiro-native-agent-and-firewall, Property 35: The timeline has one row per step and adds no markup
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startStudio, type StudioHandle } from '../../src/studio/server.js';
import { removeDir } from '../helpers/cleanup.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const LEVELS = ['http', 'accessibility', 'vision', 'terminal', 'skipped', 'not_run'] as const;
const STATUSES = ['ok', 'failed', 'skipped', 'not_run', 'blocked', 'drifted'] as const;
const hostile = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.constantFrom('<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'a & b "q" \'s\' <b>bold</b>', '</li></ol><h1>x</h1>', '&lt;i&gt;')
);
const stepArb = fc.record({
  label: hostile,
  level: fc.constantFrom(...LEVELS),
  durationMs: fc.integer({ min: 0, max: 600000 }),
  status: fc.constantFrom(...STATUSES),
  note: fc.option(hostile, { nil: undefined }),
});
const traceArb = fc.array(stepArb, { maxLength: 25 }).map((steps) => steps.map((s, index) => ({ index, ...s })));

describe('Replay timeline (real Chromium)', () => {
  let dir: string;
  let studio: StudioHandle;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'studio-timeline-prop-'));
    studio = await startStudio({ workflowFile: join(dir, 'missing.json'), outDir: join(dir, 'out'), env: {} });
    browser = await chromium.launch();
    page = await (await browser.newContext()).newPage();
    await page.goto(studio.url);
    await page.waitForSelector('main h1');
    // A string, so that the test runner does not rewrite the dynamic import
    await page.evaluate("import('/js/timeline.js').then((m) => { window.__timeline = m; })");
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await studio?.close();
    if (dir) await removeDir(dir);
  });

  it('shows one list item per step, in order, and no element made from a label', async () => {
    await fc.assert(
      fc.asyncProperty(traceArb, async (trace) => {
        const shown = await page.evaluate(async (steps) => {
          const { renderReplayTimeline } = (window as any).__timeline;
          const ol = renderReplayTimeline(steps, {});
          document.body.append(ol);
          const rows = [...ol.children].map((li: Element) => ({
            tag: li.tagName,
            text: li.textContent ?? '',
            label: li.querySelector('.tl-label'),
            labelText: li.querySelector('.tl-label')?.textContent ?? null,
            labelKids: li.querySelector('.tl-label')?.children.length ?? -1,
          }));
          const tags = [...new Set([...ol.querySelectorAll('*')].map((e: Element) => e.tagName))];
          ol.remove();
          return { tag: ol.tagName, aria: ol.getAttribute('aria-label'), rows: rows.map((r) => ({ ...r, label: undefined })), tags };
        }, trace);
        expect(shown.tag).toBe('OL');
        expect(shown.aria).toBe('Replay timeline');
        expect(shown.rows).toHaveLength(trace.length);
        shown.rows.forEach((row, i) => {
          expect(row.tag).toBe('LI');
          expect(row.text).toContain(`Step ${i + 1}`);
          expect(row.labelText).toBe(trace[i].label);
          expect(row.labelKids).toBe(0);
          expect(row.text).toContain('Level: ');
          expect(row.text).toContain('Status: ');
        });
        // Only the elements the component itself builds: nothing a label could have introduced
        for (const tag of shown.tags) expect(['LI', 'DIV', 'SPAN', 'P']).toContain(tag);
      }),
      { numRuns: 100 }
    );
  });
});
