// Feature: kiro-thin-extension, Property 16: The actions tree shows each valid workflow with its risk and tool tooltip
// **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.7**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { actionsTree } from '../../../kiro-extension/src/core/models/actions-model';
import { parseWorkflows } from '../../../kiro-extension/src/core/studio-api';
import { S } from '../../../kiro-extension/src/core/strings';

const risk = fc.constantFrom('read', 'write', 'delete');
const valid = fc.record(
  {
    id: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
    label: fc.stringMatching(/^[A-Za-z0-9 ]{1,20}$/),
    toolName: fc.stringMatching(/^[a-z_]{1,16}$/),
    risk: risk.map((highest) => ({ highest, secretLeak: 'SHOULD-NOT-APPEAR' })),
    steps: fc.constant([{ value: 'SHOULD-NOT-APPEAR' }]),
    apiKey: fc.constant('SHOULD-NOT-APPEAR'),
  },
  { requiredKeys: ['id', 'label', 'risk'] }
);
const invalid = fc.oneof(
  fc.constant(null),
  fc.constant(5),
  fc.constant({ id: 1, label: 'x', risk: { highest: 'read' } }),
  fc.constant({ id: 'a', label: 'x', risk: { highest: 'nuke' } }),
  fc.constant({ id: 'a', label: 'x' }),
  fc.constant({ id: 'a', label: 'x', risk: 'read' })
);
const word = { read: S.riskRead, write: S.riskWrite, delete: S.riskDelete } as const;

describe('Property 16: actions tree', () => {
  it('has one row per valid workflow with risk text, icon and tooltip, and nothing else of the entry', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(valid, invalid), { maxLength: 8 }), (items) => {
        const rows = parseWorkflows({ workflows: items })!;
        const validItems = items.filter((i: any) => i && typeof i === 'object' && typeof i.id === 'string' && typeof i.label === 'string' && ['read', 'write', 'delete'].includes(i.risk?.highest));
        expect(rows).toHaveLength(validItems.length);
        const tree = actionsTree({ state: 'running', folder: { status: 'ok' }, workflows: { ok: true, status: 200, data: rows } });
        if (rows.length === 0) {
          expect(tree.map((n) => n.id)).toEqual(['info:no-actions']);
          return;
        }
        expect(tree).toHaveLength(rows.length);
        tree.forEach((node, i) => {
          const w = rows[i]!;
          expect(node.label).toBe(w.label);
          expect(node.description).toBe(word[w.risk]);
          expect(node.icon).toBe(w.risk);
          expect(node.contextValue).toBe('action');
          expect(node.tooltip).toContain(w.toolName ?? S.notConnectedYet);
          expect(JSON.stringify(node)).not.toContain('SHOULD-NOT-APPEAR');
          expect(Object.keys(rows[i]!).every((k) => ['id', 'label', 'toolName', 'risk'].includes(k))).toBe(true);
        });
      }),
      { numRuns: 200 }
    );
  });

  it('shows a plain row for each non-running state, failure, folder problem and an active recording', () => {
    const one = { ok: true as const, status: 200, data: [] };
    expect(actionsTree({ state: 'stopped', folder: { status: 'ok' }, workflows: undefined })[0]).toMatchObject({ command: { id: 'daemonize.start' } });
    expect(actionsTree({ state: 'crashed', folder: { status: 'ok' }, workflows: undefined })[0]).toMatchObject({ command: { id: 'daemonize.restart' } });
    expect(actionsTree({ state: 'running', folder: { status: 'none' }, workflows: one })[0]!.label).toBe(S.noFolder);
    expect(actionsTree({ state: 'running', folder: { status: 'ok' }, workflows: { ok: false, status: 500, error: 'x' } })[0]!.label).toBe(S.loadFailed);
    const rec = actionsTree({ state: 'running', folder: { status: 'ok' }, workflows: one, recording: { state: 'recording', steps: 3, labels: [] } });
    expect(rec[0]).toMatchObject({ id: 'recording', label: S.statusRecording(3) });
  });
});
