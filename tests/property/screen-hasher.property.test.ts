// Feature: daemonize, Property 2: Screen ID determinism
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import type { ScreenContent } from '../../src/types.js';

describe('ScreenHasher — Property 2: Screen ID Determinism', () => {
  const hasher = new ScreenHasher();

  // Arbitrary for DOM ScreenContent
  const domScreenArb: fc.Arbitrary<ScreenContent> = fc.record({
    type: fc.constant('dom' as const),
    raw: fc.string({ minLength: 1, maxLength: 500 }),
    normalized: fc.string({ minLength: 1, maxLength: 500 }),
    capturedAt: fc.integer({ min: 0, max: Date.now() }),
  });

  // Arbitrary for terminal ScreenContent
  const terminalScreenArb: fc.Arbitrary<ScreenContent> = fc.record({
    type: fc.constant('terminal' as const),
    raw: fc.string({ minLength: 1, maxLength: 500 }),
    normalized: fc.string({ minLength: 1, maxLength: 500 }),
    capturedAt: fc.integer({ min: 0, max: Date.now() }),
  });

  const screenArb = fc.oneof(domScreenArb, terminalScreenArb);

  it('computes the same ScreenId when called twice on identical DOM content', () => {
    fc.assert(
      fc.property(domScreenArb, (screen) => {
        const id1 = hasher.computeId(screen);
        const id2 = hasher.computeId(screen);
        return id1 === id2 && /^[0-9a-f]{16}$/.test(id1);
      }),
      { numRuns: 100 }
    );
  });

  it('computes the same ScreenId when called twice on identical terminal content', () => {
    fc.assert(
      fc.property(terminalScreenArb, (screen) => {
        const id1 = hasher.computeId(screen);
        const id2 = hasher.computeId(screen);
        return id1 === id2 && /^[0-9a-f]{16}$/.test(id1);
      }),
      { numRuns: 100 }
    );
  });

  it('always produces a 16-character lowercase hex ScreenId', () => {
    fc.assert(
      fc.property(screenArb, (screen) => {
        const id = hasher.computeId(screen);
        return /^[0-9a-f]{16}$/.test(id);
      }),
      { numRuns: 200 }
    );
  });
});
