// Feature: kiro-global-connect-vault-bridge, Property 12: Slug validity and determinism
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { deriveSlug, SLUG_PATTERN, MAX_SLUG } from '../../src/studio/app-names';

const host = fc.stringMatching(/^[a-zA-Z0-9\u00e9\u00fc\u4e2d.-]{1,80}$/);
const source = fc.oneof(
  fc.tuple(fc.constantFrom('http', 'https'), host, fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined })).map(([scheme, h, port]) => {
    try {
      return { origin: new URL(`${scheme}://${h}${port === undefined ? '' : `:${port}`}`).origin };
    } catch {
      return { name: h };
    }
  }),
  fc.string({ maxLength: 120 }).map((name) => ({ name })),
);

describe('Property 12: slug validity and determinism', () => {
  it('always matches the server-name pattern, stays within 48 characters and is deterministic', () => {
    fc.assert(
      fc.property(source, (s) => {
        const slug = deriveSlug(s);
        expect(slug).toMatch(SLUG_PATTERN);
        expect(slug.length).toBeLessThanOrEqual(MAX_SLUG);
        expect(slug.endsWith('-')).toBe(false);
        expect(deriveSlug(s)).toBe(slug);
      }),
      { numRuns: 200 },
    );
  });
});
