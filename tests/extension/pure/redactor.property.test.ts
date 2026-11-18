// Feature: kiro-thin-extension, Property 12: Redacted text never contains a sensitive value
// **Validates: Requirements 9.3, 9.7**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createRedactor } from '../../../kiro-extension/src/core/redactor';

const ESC = String.fromCharCode(27);
const token = fc.stringMatching(/^[A-Za-z0-9_-]{16,40}$/);
const secretValue = fc.stringMatching(/^[A-Z0-9]{8,20}$/);
const filler = fc.stringMatching(/^[a-z ]{0,12}$/);
const ansi = fc.constantFrom('', `${ESC}[31m`, `${ESC}[0m`, `${ESC}[1;32m`);

describe('Property 12: redaction', () => {
  it('removes the token, literals, DAEMONIZE_SECRET_* values, token= and Bearer values and all ANSI', () => {
    fc.assert(
      fc.property(
        token,
        fc.array(secretValue, { minLength: 1, maxLength: 3 }),
        secretValue,
        fc.array(fc.tuple(filler, fc.constantFrom('raw', 'query', 'bearer', 'literal', 'env'), ansi, ansi), { minLength: 1, maxLength: 8 }),
        (tok, literals, envSecret, parts) => {
          const redact = createRedactor({
            sensitiveValues: () => [tok, ...literals],
            env: () => ({ DAEMONIZE_SECRET_PASSWORD: envSecret, OTHER: 'ignored-value' }),
          });
          let text = '';
          for (const [pad, kind, a, b] of parts) {
            const piece =
              kind === 'raw' ? tok : kind === 'query' ? `http://x/?token=${tok}&a=1` : kind === 'bearer' ? `Bearer ${tok}` : kind === 'literal' ? literals[0]! : envSecret;
            text += `${pad}${a}${piece}${b}\n`;
          }
          const out = redact(text);
          expect(out).not.toContain(tok);
          for (const l of literals) expect(out).not.toContain(l);
          expect(out).not.toContain(envSecret);
          expect(out).not.toContain(ESC);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('masks a value split by an ANSI sequence and ignores literals shorter than 3 characters', () => {
    const redact = createRedactor({ sensitiveValues: () => ['SECRET99', 'a'], env: () => ({}) });
    expect(redact(`SEC${ESC}[0mRET99`)).toBe('***');
    expect(redact('banana')).toBe('banana');
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
    expect(redact('GET /?token=zzz&x=1')).toBe('GET /?token=***&x=1');
  });
});
