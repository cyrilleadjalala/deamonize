// Feature: kiro-thin-extension, Property 14: Extension validators agree with the Studio validators
// **Validates: Requirements 11.2, 11.3, 11.4**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateName, validateUrl } from '../../../kiro-extension/src/core/validate';
import { validateName as studioName, validateUrl as studioUrl } from '../../../src/studio/validate-action';

const text = fc.oneof(
  fc.string({ maxLength: 100 }),
  fc.string({ unit: 'binary', maxLength: 60 }),
  fc.string({ unit: 'grapheme', maxLength: 60 }),
  fc.constantFrom('', ' ', '   a  ', 'Create invoice', 'a\nb', 'a\u007fb', '\u{1F600}', '\u{1F600}a', 'http://x', 'https://example.com/a?b#c', 'ftp://x', 'http://u:p@x', 'http://u@x', 'x'.repeat(81), 'a'.repeat(80), '\u{1F600}'.repeat(80) + 'a', 'http://' + 'a'.repeat(2050), `https://${'a'.repeat(2030)}.com`),
  fc.integer({ min: 1, max: 100 }).map((n) => 'a'.repeat(n)),
  fc.webUrl(),
  fc.tuple(fc.constantFrom('http', 'https', 'file', 'javascript'), fc.string({ maxLength: 20 })).map(([s, r]) => `${s}://${r}`)
);
const anyInput = fc.oneof(text, fc.constantFrom(undefined, null, 0, 1, true, {}, [], ['a']) as fc.Arbitrary<unknown>);

describe('Property 14: validator parity', () => {
  it('validateName agrees with the Studio on ok, value and message', () => {
    fc.assert(fc.property(anyInput, (input) => { expect(validateName(input)).toEqual(studioName(input)); }), { numRuns: 400 });
  });
  it('validateUrl agrees with the Studio on ok, value and message', () => {
    fc.assert(fc.property(anyInput, (input) => { expect(validateUrl(input)).toEqual(studioUrl(input)); }), { numRuns: 400 });
  });
});
