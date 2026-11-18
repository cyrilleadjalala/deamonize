// Feature: user-journey-improvements, Property 32: Missing secrets are names, sorted and bounded
// **Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5, 20.12**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normalizeSecretNames } from '../../src/studio/install-scope.js';
import { runKiroRecording } from '../helpers/kiro-recording.js';

const NAME = /^[A-Z][A-Z0-9_]*$/;
const validName = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/);
const entry = fc.oneof(validName, validName, fc.string(), fc.integer(), fc.constant(null), fc.constant(undefined), fc.constant({}));
const list = fc.oneof(fc.array(entry, { maxLength: 250 }), fc.array(validName, { minLength: 101, maxLength: 160 }), fc.constant(undefined), fc.string(), fc.constant(null));
const codePointSorted = (names: string[]): boolean => names.every((n, i) => i === 0 || names[i - 1] < n);

describe('Property 32: Missing secrets are names, sorted and bounded', () => {
  it('normalizeSecretNames keeps only valid, unique names, sorted, at most 100', () => {
    fc.assert(
      fc.property(list, (value) => {
        const out = normalizeSecretNames(value);
        expect(out.length).toBeLessThanOrEqual(100);
        expect(out.every((n) => NAME.test(n))).toBe(true);
        expect(new Set(out).size).toBe(out.length);
        expect(codePointSorted(out)).toBe(true);
        if (Array.isArray(value)) {
          const valid = [...new Set(value.filter((v): v is string => typeof v === 'string' && NAME.test(v)))];
          expect(out.length).toBe(Math.min(100, valid.length));
        } else {
          expect(out).toEqual([]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the status carries the normalized arrays after an install and none after a failure', async () => {
    await fc.assert(
      fc.asyncProperty(list, list, fc.boolean(), async (missing, required, fails) => {
        const r = await runKiroRecording('global', {
          installAnswer: { missingSecrets: missing, requiredSecrets: required },
          ...(fails ? { installFails: 'No write access' } : {}),
        });
        const kiro = r.manager.status().kiro!;
        if (fails) {
          expect(kiro.added).toBe(false);
          expect(kiro).not.toHaveProperty('missingSecrets');
          expect(kiro).not.toHaveProperty('requiredSecrets');
        } else {
          expect(kiro.missingSecrets).toEqual(normalizeSecretNames(missing));
          expect(kiro.requiredSecrets).toEqual(normalizeSecretNames(required));
          for (const n of [...kiro.missingSecrets!, ...kiro.requiredSecrets!]) expect(n).toMatch(NAME);
        }
      }),
      { numRuns: 100 },
    );
  });
});
