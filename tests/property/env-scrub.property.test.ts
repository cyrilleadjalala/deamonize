// Feature: kiro-global-connect-vault-bridge, Property 1: Test environment scrubbing
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { scrubEnv, isScrubbed } from '../helpers/env-scrub';

const suffix = fc.stringMatching(/^[A-Z0-9_]{0,12}$/);
const scrubbedName = fc.oneof(
  suffix.map((s) => `DAEMONIZE_SECRET_${s}`),
  suffix.map((s) => `DAEMONIZE_MODEL_${s}`),
  fc.constantFrom('DAEMONIZE_DATA_DIR', 'DAEMONIZE_APP_KEY'),
);
const keptName = fc.oneof(
  fc.constantFrom('PATH', 'DAEMONIZE_VAULT_KEY_PROVIDER', 'DAEMONIZE_CHROMIUM_PATH', 'DAEMONIZE_DATA_DIR_X', 'DAEMONIZE_APP_KEY2'),
  suffix.map((s) => `OTHER_${s}`),
);
const envArb = fc.dictionary(fc.oneof(scrubbedName, keptName), fc.string(), { maxKeys: 12 });

describe('Property 1: Test environment scrubbing', () => {
  /** **Validates: Requirements 1.1** */
  it('removes every scrubbed variable, keeps the others and leaves the input untouched', () => {
    fc.assert(
      fc.property(envArb, (env) => {
        const before = { ...env };
        const out = scrubEnv(env);
        expect(isScrubbed(out as Record<string, string>)).toBe(true);
        expect(env).toEqual(before);
        for (const [name, value] of Object.entries(env)) {
          if (isScrubbed({ [name]: value })) expect(out[name]).toBe(value);
          else expect(name in out).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
