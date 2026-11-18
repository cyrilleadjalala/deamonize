// Feature: user-journey-improvements, Property 1: Variable fields round trip
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { oldWorkflowSetArb, workflowSetArb } from '../helpers/workflow-arbitraries.js';

describe('Property 1: Variable fields round trip', () => {
  /** **Validates: Requirements 1.4, 1.5, 10.3** */
  it('serializing then loading returns the same values, and an absent field stays absent', () => {
    fc.assert(
      fc.property(workflowSetArb(), (set) => {
        const text = serializeWorkflowSet(set);
        const loaded = deserializeWorkflowSet(text);
        expect(loaded).toEqual(set);
        expect(serializeWorkflowSet(loaded)).toBe(text);
        loaded.workflows.forEach((workflow, w) => {
          for (const key of ['description', 'startUrl', 'storageState'] as const) {
            expect(Object.prototype.hasOwnProperty.call(workflow, key)).toBe(Object.prototype.hasOwnProperty.call(set.workflows[w], key));
          }
          workflow.variables.forEach((variable, v) => {
            for (const key of ['type', 'optional', 'whenOmitted'] as const) {
              expect(Object.prototype.hasOwnProperty.call(variable, key)).toBe(Object.prototype.hasOwnProperty.call(set.workflows[w].variables[v], key));
            }
          });
        });
      }),
      { numRuns: 150 },
    );
  });

  it('a set with none of the new fields serializes to the same bytes as before', () => {
    fc.assert(
      fc.property(oldWorkflowSetArb, (set) => {
        expect(serializeWorkflowSet(set)).toBe(JSON.stringify(set, null, 2));
      }),
      { numRuns: 100 },
    );
  });
});