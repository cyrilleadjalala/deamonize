// Feature: kiro-thin-extension, Property 18: A typed secret value appears only in the body of one POST
// Validates: Requirements 9.5, 13.5, 13.6, 13.10, 13.13
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { __calls, __objects, __script, env } from '../fake-vscode';
import { StudioClientError } from '../../../kiro-extension/src/core/studio-client';
import { containsText, createHarness } from './harness';

type Scenario = 'ok' | 'bad-request' | 'unavailable' | 'network' | 'unauthorized';
const SCENARIOS: Scenario[] = ['ok', 'bad-request', 'unavailable', 'network', 'unauthorized'];

const secretValue = fc
  .tuple(
    fc.constantFrom('SECRETVALUE-', 'otpauth://totp/x?secret=', 'JBSWY3DPEHPK3PXP', 'p@ss "quoted" \\ '),
    fc.string({ minLength: 3, maxLength: 30 }),
  )
  .map(([prefix, rest]) => prefix + rest);

describe('typed secret values', () => {
  it('appear only in the body of one POST /api/secrets', async () => {
    await fc.assert(
      fc.asyncProperty(secretValue, fc.constantFrom(...SCENARIOS), async (value, scenario) => {
        const answers: Record<Scenario, () => unknown> = {
          ok: () => ({ ok: true, status: 200, data: { name: 'DAEMONIZE_SECRET_PASSWORD', configured: true } }),
          'bad-request': () => ({ ok: false, status: 400, error: `That value is not valid: ${value}` }),
          unavailable: () => ({ ok: false, status: 503, error: `The safe store is unavailable (${value})` }),
          network: () => { throw new StudioClientError('network', `connect failed while sending ${value}`); },
          unauthorized: () => { throw new StudioClientError('unauthorized', `rejected ${value}`); },
        };
        const harness = createHarness({
          secrets: async () => ({ ok: true, status: 200, data: [{ name: 'DAEMONIZE_SECRET_PASSWORD', kind: 'password', configured: false }] }),
          setSecret: async () => answers[scenario](),
        });
        __script({ 'window.showInputBox': [value] });

        await harness.run('daemonize.setCredential', {
          id: 'secret:DAEMONIZE_SECRET_PASSWORD', label: 'DAEMONIZE_SECRET_PASSWORD', icon: 'key', contextValue: 'secret.missing',
        });

        const sets = harness.apiCalls.filter((c) => c.method === 'setSecret');
        expect(sets).toHaveLength(1);
        expect(sets[0].args).toEqual(['DAEMONIZE_SECRET_PASSWORD', value]);

        // No other Studio call carries the value
        for (const call of harness.apiCalls.filter((c) => c.method !== 'setSecret')) {
          expect(containsText(call.args, value)).toBe(false);
        }
        // Nothing the user could see or any outgoing editor call holds it
        expect(containsText(__calls, value)).toBe(false);
        expect(containsText(__objects.map((o) => o.value), value)).toBe(false);
        for (const entry of __objects) {
          if (entry.kind === 'treeView') {
            const provider = entry.value.options.treeDataProvider as { getChildren(): unknown };
            expect(containsText(provider.getChildren(), value)).toBe(false);
          }
        }
        expect(env.clipboardText.includes(value)).toBe(false);
        await harness.handle.dispose();
      }),
      { numRuns: 120 },
    );
  });

  it('is never asked for when the input box is dismissed or left empty', async () => {
    for (const answer of [undefined, '']) {
      const harness = createHarness({
        secrets: async () => ({ ok: true, status: 200, data: [{ name: 'DAEMONIZE_SECRET_PASSWORD', kind: 'password', configured: false }] }),
      });
      __script({ 'window.showInputBox': [answer] });
      await harness.run('daemonize.setCredential', { id: 'secret:DAEMONIZE_SECRET_PASSWORD', label: 'DAEMONIZE_SECRET_PASSWORD', icon: 'key' });
      expect(harness.apiCalls.filter((c) => c.method === 'setSecret')).toHaveLength(0);
    }
  });
});
