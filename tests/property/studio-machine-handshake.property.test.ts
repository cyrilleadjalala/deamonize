// Feature: kiro-thin-extension, Property 5: Handshake round trip and single line
// **Validates: Requirements 3.2, 3.6, 3.11**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatHandshakeLine } from '../../src/cli/commands/studio';

// The extension's parseHandshakeLine is owned by another group; the round trip is checked with JSON.parse,
// which is what that parser starts with.
describe('Property 5: handshake round trip and single line', () => {
  it('formats one line that parses back to the same three fields', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer({ min: 1, max: 2 ** 31 - 1 }), (origin, token, pid) => {
        const line = formatHandshakeLine({ origin, token, pid });
        expect(line.endsWith('\n')).toBe(true);
        expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
        expect(line.indexOf('\n')).toBe(line.length - 1);
        expect(JSON.parse(line)).toEqual({ origin, token, pid });
        expect(Object.keys(JSON.parse(line))).toEqual(['origin', 'token', 'pid']);
      }),
      { numRuns: 200 },
    );
  });
});
