/**
 * Requirement 1.4, 7.11 and 10.3: a Workflow_File written before the user-journey changes (no new field) still loads,
 * and serializes to the same bytes as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';
import { oldWorkflowSetArb } from '../helpers/workflow-arbitraries.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'regression');

function oldFile(): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'Old app',
    startUrl: 'https://old.example.test/start',
    workflows: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        label: 'Old action',
        steps: [
          { actionType: 'type', selectors: ['input[name="q"]'], variable: 'query', value: 'abc' },
          { actionType: 'click', selectors: ['button'] },
        ],
        // optional: true with no whenOmitted is an old file
        variables: [{ name: 'query', type: 'string', optional: true }],
        observedPayloads: [{ query: 'abc' }],
      },
    ],
  };
}

describe('old Workflow_File compatibility of the schema', () => {
  for (const name of ['pre-change.workflows.json', 'pre-change-tui.workflows.json']) {
    it(`loads ${name} unchanged and writes the same data back`, () => {
      const text = readFileSync(join(FIXTURES, name), 'utf-8');
      const set = deserializeWorkflowSet(text);
      expect(JSON.parse(serializeWorkflowSet(set))).toEqual(JSON.parse(text));
      for (const workflow of set.workflows) {
        expect(workflow.description).toBeUndefined();
        expect(workflow.startUrl).toBeUndefined();
        expect(workflow.storageState).toBeUndefined();
        for (const variable of workflow.variables) expect(variable.whenOmitted).toBeUndefined();
      }
    });
  }

  it('keeps optional: true without whenOmitted, and writes the same bytes', () => {
    const text = serializeWorkflowSet(oldFile());
    expect(text).toBe(JSON.stringify(oldFile(), null, 2));
    const loaded = deserializeWorkflowSet(text);
    expect(loaded.workflows[0].variables[0]).toEqual({ name: 'query', type: 'string', optional: true });
    expect(serializeWorkflowSet(loaded)).toBe(text);
  });

  it('loads a file with check-free steps and refuses nothing about them', () => {
    const set = oldFile();
    set.workflows[0].steps.push({ actionType: 'select', selectors: ['select'], value: 'a' }, { actionType: 'keypress', selectors: [], value: 'Enter' });
    const loaded = deserializeWorkflowSet(JSON.stringify(set));
    expect(loaded.workflows[0].steps.map((step) => step.actionType)).toEqual(['type', 'click', 'select', 'keypress']);
  });

  it('writes the same bytes for any old-shaped set', () => {
    fc.assert(
      fc.property(oldWorkflowSetArb, (set) => {
        const text = serializeWorkflowSet(set);
        expect(text).toBe(JSON.stringify(set, null, 2));
        expect(serializeWorkflowSet(deserializeWorkflowSet(text))).toBe(text);
      }),
      { numRuns: 100 },
    );
  });
});
