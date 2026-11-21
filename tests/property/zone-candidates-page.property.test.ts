// Feature: result-zone-selector-robustness, Properties 3, 9, 10 and 11 (determinism, proven candidates, fragile classification, role alone), on a live page
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { LiveRecorder, type MarkResultRequest } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { isFragile, zoneCandidateSelectors } from '../../src/recorder/zone-candidates.js';
import { isPositionalSelector } from '../../src/recorder/minimal-selector.js';
import type { ElementInfo } from '../../src/recorder/selector-builder.js';
import { markedPage, minimalSelectorText, positionalSelectorText, type MarkedPage } from '../helpers/zone-arbitraries.js';

vi.setConfig({ testTimeout: 300000, hookTimeout: 60000 });

const runs = { numRuns: 100 };

describe('result zone candidates on a live page', () => {
  let browser: Browser;
  let page: Page;
  let live: LiveRecorder;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    page = await browser.newPage();
    await page.goto('about:blank');
    live = new LiveRecorder(page, new WorkflowRecorder('ZonePage'));
    await live.attach();
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Loads the document and marks one element the way a click does: the helpers of the page tell which element is the target. */
  async function mark(sample: MarkedPage): Promise<{ info: ElementInfo; facts: MarkResultRequest['zone'] }> {
    await page.setContent(sample.html);
    await page.waitForSelector('[data-daemonize-ui]', { state: 'attached' });
    return page.evaluate((index) => {
      const w = window as unknown as { __zoneTarget?: Element; __daemonizeHelpers: Record<string, (...a: unknown[]) => unknown> };
      const all = Array.from(document.body.querySelectorAll('*')).filter((e) => !e.closest('[data-daemonize-ui]'));
      const node = all[index % all.length];
      w.__zoneTarget = node;
      w.__daemonizeHelpers.isZoneTarget = (el: unknown) => el === w.__zoneTarget;
      return { info: w.__daemonizeHelpers.infoOf(node, null), facts: w.__daemonizeHelpers.zoneFactsOf(node) } as never;
    }, sample.index);
  }

  const resolvesToTarget = async (selector: string): Promise<boolean> => {
    const locator = page.locator(selector);
    if ((await locator.count()) !== 1) return false;
    return locator.evaluate((el) => el === (window as unknown as { __zoneTarget?: Element }).__zoneTarget);
  };

  // Feature: result-zone-selector-robustness, Property 3: Determinism of the stored zone
  it('Property 3: Determinism of the stored zone', async () => {
    // Validates: Requirements 1.8
    await fc.assert(
      fc.asyncProperty(markedPage, async (sample) => {
        const { info, facts } = await mark(sample);
        const first = new LiveRecorder(page, new WorkflowRecorder('A'));
        const second = new LiveRecorder(page, new WorkflowRecorder('B'));
        const request = { info, kind: 'text', zone: facts };
        const a = await first.markResultInFrame(request, page.mainFrame());
        const b = await second.markResultInFrame(structuredClone(request), page.mainFrame());
        expect(b).toEqual(a);
        expect(second.resultZone).toEqual(first.resultZone);
        const again = await page.evaluate(() => {
          const w = window as unknown as { __zoneTarget: Element; __daemonizeHelpers: Record<string, (...a: unknown[]) => unknown> };
          return w.__daemonizeHelpers.zoneFactsOf(w.__zoneTarget);
        });
        expect(again).toEqual(facts);
      }),
      runs
    );
  });

  // Feature: result-zone-selector-robustness, Property 9: Candidates are proven
  it('Property 9: Candidates are proven', async () => {
    // Validates: Requirements 2.1, 2.3, 11.1
    await fc.assert(
      fc.asyncProperty(markedPage, async (sample) => {
        const { info, facts } = await mark(sample);
        const result = await live.markResultInFrame({ info, kind: 'text', zone: facts }, page.mainFrame());
        if (!result.ok || result.selectors === undefined) return;
        for (const selector of result.selectors) {
          // A stored candidate that is not the positional fallback was proven; the fallback is kept only when nothing was proven
          expect(await resolvesToTarget(selector) || (isPositionalSelector(selector) && selector === facts?.positional)).toBe(true);
        }
        const proven: string[] = [];
        for (const raw of zoneCandidateSelectors(info, facts ?? {})) {
          try {
            if (await resolvesToTarget(raw)) proven.push(raw);
          } catch {
            // a candidate the engine rejects is not proven
          }
        }
        // Nothing unproven is stored while a proven candidate exists
        if (proven.length > 0) for (const s of result.selectors) expect(proven).toContain(s);
      }),
      runs
    );
  });

  // Feature: result-zone-selector-robustness, Property 10: Fragile classification
  it('Property 10: Fragile classification', async () => {
    // Validates: Requirements 2.2, 8.1, 8.3
    expect(isFragile([])).toBe(true);
    fc.assert(
      fc.property(fc.array(fc.oneof(minimalSelectorText, positionalSelectorText), { maxLength: 5 }), (list) => {
        expect(isFragile(list)).toBe(list.every((s) => isPositionalSelector(s)));
      }),
      runs
    );
    await fc.assert(
      fc.asyncProperty(markedPage, async (sample) => {
        const { info, facts } = await mark(sample);
        const result = await live.markResultInFrame({ info, kind: 'text', zone: facts }, page.mainFrame());
        if (!result.ok || result.selectors === undefined) return;
        expect(result.fragile).toBe(result.selectors.length === 0 || result.selectors.every((s) => isPositionalSelector(s)));
      }),
      runs
    );
  });

  // Feature: result-zone-selector-robustness, Property 11: A role alone is emitted and kept only when unique
  it('Property 11: A role alone is emitted and kept only when unique', async () => {
    // Validates: Requirements 5.1, 5.2, 5.3, 5.4
    let withRole = 0;
    await fc.assert(
      fc.asyncProperty(markedPage, async (sample) => {
        const { info: recorded, facts } = await mark(sample);
        if (recorded.role === undefined) return;
        withRole += 1;
        const info: ElementInfo = { ...recorded, name: undefined };
        const alone = `role=${info.role}`;
        expect(zoneCandidateSelectors(info, facts ?? {})).toContain(alone);
        const result = await live.markResultInFrame({ info, kind: 'text', zone: facts }, page.mainFrame());
        if (!result.ok || result.selectors === undefined) return;
        const unique = await resolvesToTarget(alone).catch(() => false);
        expect(result.selectors.includes(alone)).toBe(unique);
        for (const s of result.selectors) expect(s).not.toMatch(/^role=\w+\[name=/);
      }),
      runs
    );
    expect(withRole).toBeGreaterThan(0);
  });
});
