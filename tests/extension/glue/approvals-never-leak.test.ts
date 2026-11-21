// Feature: kiro-native-agent-and-firewall, Property 34: The Activity summary shows facts, not values
// **Validates: Requirements 13.6, 17.7**
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { __calls, __objects, __script } from '../fake-vscode';
import { containsText, createHarness, TEST_TOKEN, type Harness } from './harness';

let active: Harness | undefined;
afterEach(async () => { await active?.handle.dispose(); active = undefined; });

const value = fc.stringMatching(/^ARGVALUE-[a-z0-9]{8,16}$/);

describe('approvals never leak', () => {
  it('no argument value and no token in any notification, output line or opened address text', async () => {
    await fc.assert(
      fc.asyncProperty(value, fc.constantFrom('Approve', 'Deny', undefined), async (secret, choice) => {
        active = createHarness();
        const id = 'cd'.repeat(16);
        const session = active.manager.session as unknown as { client: unknown };
        session.client = {
          get: async (path: string) => (path.startsWith('/api/approvals')
            ? { status: 200, body: { pending: [{ id, tool: 'send_invoice', application: 'Billing', riskText: 'Changes data', arguments: { amount: secret, list: [secret] }, summary: secret, writeSteps: [], secondsLeft: 60, kind: 'tool-call' }], serverTime: 'n' } }
            : { status: 200, body: { entries: [{ at: new Date().toISOString(), tool: 'send_invoice', decision: 'approved', outcome: 'success', arguments: { amount: secret } }], tools: [], total: 1 } }),
          post: async () => ({ status: 500, body: { error: 'x' } }),
        };
        __script({ 'window.showInformationMessage': [choice] });
        active.manager.setState('stopped');
        active.manager.setState('running');
        for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
        await active.run('daemonize.approve', `approval:${id}`);
        const shown = __calls.filter((c) => c.api.startsWith('window.show')).map((c) => c.args);
        expect(containsText(shown, secret)).toBe(false);
        expect(containsText(shown, TEST_TOKEN)).toBe(false);
        expect(containsText(__objects.map((o) => o.value), secret)).toBe(false);
        expect(containsText(__objects.map((o) => o.value), TEST_TOKEN)).toBe(false);
        await active.handle.dispose();
        active = undefined;
      }),
      { numRuns: 100 },
    );
  });
});
