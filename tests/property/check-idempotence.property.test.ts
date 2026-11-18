// Feature: user-journey-improvements, Property 14: A check step is idempotent
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Locator } from 'playwright';
import { NonRetryableAction, checkControl, checkTarget, needsClick } from '../../src/replay/runtime/web-steps.js';

/** A control with no browser: `responsive` false is a control that ignores clicks. */
function fakeControl(initial: boolean, disabled: boolean, responsive: boolean) {
  const state = { checked: initial, clicks: 0 };
  const locator = {
    evaluate: async () => ({ checked: state.checked, disabled }),
    click: async () => {
      state.clicks++;
      if (responsive) state.checked = !state.checked;
    },
  } as unknown as Locator;
  return { state, locator };
}

describe('Property 14: A check step is idempotent', () => {
  /** **Validates: Requirements 7.4, 7.5, 7.8, 7.12** */
  it('clicks at most once, never when already at the target, and ends at the target', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), async (initial, target, disabled, responsive) => {
        const { state, locator } = fakeControl(initial, disabled, responsive);
        let error: unknown;
        await checkControl(locator, target, 60).catch((err) => { error = err; });
        expect(state.clicks).toBe(initial === target || disabled ? 0 : 1);
        if (initial === target) {
          expect(error).toBeUndefined();
        } else if (disabled || !responsive) {
          expect(error).toBeInstanceOf(NonRetryableAction);
        } else {
          expect(error).toBeUndefined();
          expect(state.checked).toBe(target);
        }
        // Running it again changes nothing
        if (error === undefined) {
          await checkControl(locator, target, 60);
          expect(state.clicks).toBe(initial === target ? 0 : 1);
        }
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 7.4, 7.12** */
  it('derives the target from the supplied value, else the recorded one', () => {
    fc.assert(
      fc.property(fc.constantFrom('true', 'false', 'TRUE', 'x', undefined), fc.constantFrom('true', 'false', undefined), fc.boolean(), (resolved, recorded, current) => {
        const target = checkTarget(resolved, recorded);
        const word = (v: string | undefined) => (v?.toLowerCase() === 'true' ? true : v?.toLowerCase() === 'false' ? false : undefined);
        expect(target).toBe(word(resolved) ?? word(recorded));
        if (target !== undefined) expect(needsClick(current, target)).toBe(current !== target);
      }),
      { numRuns: 100 },
    );
  });
});
