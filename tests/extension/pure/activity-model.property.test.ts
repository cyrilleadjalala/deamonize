// Feature: kiro-native-agent-and-firewall, Property 34: The Activity summary shows facts, not values
// **Validates: Requirements 17.1, 17.2, 17.4, 17.5, 17.7**
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { activityNodes } from '../../../kiro-extension/src/core/activity-model';
import { bannedTermsIn } from '../../../kiro-extension/src/core/plain-language';
import { S } from '../../../kiro-extension/src/core/strings';
import type { ActivityRow, ApprovalRow, TreeNode } from '../../../kiro-extension/src/core/types';

const NOW = Date.parse('2025-06-01T12:00:00Z');
const marker = fc.stringMatching(/^ARGVALUE-[a-z0-9]{6,12}$/);
const approval = fc.record({
  id: fc.stringMatching(/^[0-9a-f]{32}$/),
  tool: fc.constantFrom('send_invoice', 'delete_client', 'update_order'),
  application: fc.constantFrom('Billing', 'Shop'),
  riskText: fc.constantFrom('Changes data', 'Deletes data'),
  value: marker,
  secondsLeft: fc.integer({ min: 0, max: 120 }),
}).map((r): ApprovalRow => ({
  id: r.id, tool: r.tool, application: r.application, riskText: r.riskText, arguments: { amount: r.value, note: [r.value] },
  writeSteps: [], secondsLeft: r.secondsLeft, kind: 'tool-call',
}));
const entry = fc.record({
  offset: fc.integer({ min: 0, max: 400 * 24 * 3600 * 1000 }),
  tool: fc.constantFrom('list_clients', 'send_invoice', 'delete_client'),
  decision: fc.constantFrom<ActivityRow['decision']>('auto', 'approved', 'denied', 'timeout', 'unavailable'),
  success: fc.boolean(),
}).map((r): ActivityRow => ({ at: new Date(NOW - r.offset).toISOString(), tool: r.tool, decision: r.decision, success: r.success }));

const labels = [S.decisionApproved, S.decisionDenied, S.decisionTimeout, S.decisionAuto, S.decisionUnavailable];
const texts = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => [n.label, n.description ?? '', n.tooltip ?? '']);

describe('Property 34: Activity summary', () => {
  it('lists pending first, at most 5 newest entries with tool, decision, outcome and time, and no argument value', () => {
    fc.assert(
      fc.property(fc.array(approval, { maxLength: 4 }), fc.array(entry, { maxLength: 12 }), (pending, recent) => {
        const nodes = activityNodes({ running: true, pending, recent, now: NOW });
        // pending first
        pending.forEach((p, i) => {
          expect(nodes[i].id).toBe(`approval:${p.id}`);
          expect(nodes[i].contextValue).toBe('approval');
          expect(nodes[i].label).toBe(p.tool);
        });
        const rest = nodes.slice(pending.length);
        if (recent.length === 0) {
          expect(rest.map((n) => n.label)).toEqual([S.activityNothing]);
        } else {
          expect(rest).toHaveLength(Math.min(5, recent.length));
          const newest = [...recent].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);
          rest.forEach((n, i) => {
            expect(n.label).toBe(newest[i].tool);
            const [decision, outcome, time] = (n.description ?? '').split(' · ');
            expect(labels).toContain(decision);
            expect(outcome).toBe(newest[i].success ? S.outcomeWorked : S.outcomeFailed);
            expect(time).toMatch(/ago$|^Just now$/);
          });
        }
        // facts, not values
        const all = texts(nodes).join('\n');
        expect(all).not.toMatch(/ARGVALUE-/);
        for (const t of texts(nodes)) expect(bannedTermsIn(t)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('shows the single start line when the Studio is not running', () => {
    fc.assert(
      fc.property(fc.array(approval, { maxLength: 3 }), fc.array(entry, { maxLength: 6 }), (pending, recent) => {
        const nodes = activityNodes({ running: false, pending, recent, now: NOW });
        expect(nodes.map((n) => n.label)).toEqual([S.activityStart]);
      }),
      { numRuns: 100 },
    );
  });
});
