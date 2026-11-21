import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { candidateBudgets } from '../../src/replay/runtime/extract.js';

describe('zone time budget', () => {
  // Feature: result-zone-selector-robustness, Property 16: Time budget
  // **Validates: Requirements 6.5**
  it('Property 16: time budget', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 120000 }), (n, extra) => {
        const T = 2 * n + extra;
        const b = candidateBudgets(T, n);
        expect(b).toHaveLength(n);
        expect(b.every((x) => x >= 1)).toBe(true);
        expect(b.reduce((a, x) => a + x, 0)).toBeLessThanOrEqual(T);
        expect(b[0]).toBe(Math.max(...b));
      }),
      { numRuns: 200 }
    );
  });
});