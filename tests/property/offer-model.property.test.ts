// Feature: user-journey-improvements, Property 11: The offer model keeps earlier fields
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { chromium, type Browser, type Page } from 'playwright';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';

type Event =
  | { t: 'typed'; fieldId: string; route: string }
  | { t: 'input'; fieldId: string }
  | { t: 'route'; route: string }
  | { t: 'clear' };

const fieldId = fc.integer({ min: 0, max: 130 }).map((n) => 'f' + n);
const route = fc.constantFrom('/a', '/b', '/c');
const eventArb: fc.Arbitrary<Event> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant('typed' as const), fieldId, route }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('input' as const), fieldId }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('route' as const), route }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('clear' as const) }) },
);

interface Step { event: Event; offer: string | null; earlier: string[]; route: string }

describe('Property 11: The offer model keeps earlier fields', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath: process.env.DAEMONIZE_CHROMIUM_PATH || undefined });
    page = await browser.newPage();
    await page.setContent('<body></body>');
    await page.evaluate(CAPTURE_SCRIPT);
  }, 60000);

  afterAll(async () => {
    await browser?.close();
  });

  /** **Validates: Requirements 6.1, 6.2** */
  it('never loses a field to an input or a route change, and never lists a field twice', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 1, maxLength: 60 }), async (events) => {
        const steps = (await page.evaluate((list) => {
          const model = (window as any).__daemonizeHelpers.offerModel.create('/a');
          return list.map((event: any, index: number) => {
            model.apply(event.t === 'typed' ? { ...event, stepIndex: index, suggestion: 's', label: 'l' } : event);
            return {
              event,
              offer: model.offer === null ? null : model.offer.fieldId,
              earlier: model.earlier.map((o: { fieldId: string }) => o.fieldId),
              route: model.route,
            };
          });
        }, events)) as Step[];

        let previous: Step = { event: { t: 'clear' }, offer: null, earlier: [], route: '/a' };
        for (const step of steps) {
          // One entry per field, at most 100
          expect(new Set(step.earlier).size).toBe(step.earlier.length);
          expect(step.earlier.length).toBeLessThanOrEqual(100);

          const event = step.event;
          if (event.t === 'route') {
            // 6.2: no offer, and every earlier offer stays
            expect(step.offer).toBeNull();
            expect(step.earlier).toEqual(previous.earlier);
            expect(step.route).toBe(event.route);
          } else if (event.t === 'input' && previous.offer !== null && previous.offer !== event.fieldId) {
            // 6.1: the offer stays, and the previous one is available in the list
            expect(step.offer).toBe(previous.offer);
            expect(step.earlier).toContain(previous.offer);
          } else if (event.t === 'input') {
            expect(step.offer).toBe(previous.offer);
            expect(step.earlier).toEqual(previous.earlier);
          } else if (event.t === 'typed' && event.route === previous.route) {
            expect(step.offer).toBe(event.fieldId);
            expect(step.earlier).not.toContain(event.fieldId);
            if (previous.offer !== null && previous.offer !== event.fieldId) expect(step.earlier).toContain(previous.offer);
          } else if (event.t === 'typed') {
            // A result that comes back for another route is ignored
            expect(step.offer).toBe(previous.offer);
            expect(step.earlier).toEqual(previous.earlier);
          }
          previous = step;
        }
      }),
      { numRuns: 100 },
    );
  }, 120000);
});
