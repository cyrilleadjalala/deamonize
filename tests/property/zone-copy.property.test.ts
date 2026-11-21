// Feature: result-zone-selector-robustness, Property 22: Panel text is plain
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ZONE_COPY } from '../../src/recorder/zone-copy.js';
import { CAPTURE_SCRIPT } from '../../src/recorder/capture-script.js';

/** The banned whole words of tests/unit/studio-ui-copy.test.ts. */
const BANNED = /\b(record|compile|storage state|environment variable|MCP|JSON|token|CLI)\b/i;

describe('zone copy', () => {
  // Feature: result-zone-selector-robustness, Property 22: Panel text is plain
  it('Property 22: Panel text is plain', () => {
    // Validates: Requirements 8.2, 8.6, 11.8
    const texts = Object.values(ZONE_COPY) as string[];
    expect(texts.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...texts), (text) => {
        expect(BANNED.test(text)).toBe(false);
        expect(text).not.toMatch(/`|\$\{/);
        expect(CAPTURE_SCRIPT.includes(text)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
