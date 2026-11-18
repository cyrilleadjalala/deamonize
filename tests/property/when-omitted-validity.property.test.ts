// Feature: user-journey-improvements, Property 2: whenOmitted validity
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';

const ID = '33333333-3333-4333-8333-333333333333';

function fileWith(variable: Record<string, unknown>): string {
  return JSON.stringify({
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'https://app.test/',
    workflows: [{ id: ID, label: 'Action', steps: [{ actionType: 'click', selectors: ['button'] }], variables: [variable], observedPayloads: [] }],
  });
}

const whenOmittedArb = fc.oneof(
  fc.constantFrom('useRecorded', 'skip', 'Skip', 'USERECORDED', '', ' skip', 'error'),
  fc.string({ maxLength: 12 }),
  fc.constant(null),
  fc.integer(),
  fc.boolean(),
  fc.constant(undefined),
);
const optionalArb = fc.constantFrom(true, false, undefined);

describe('Property 2: whenOmitted validity', () => {
  /** **Validates: Requirements 1.1, 1.2, 1.3** */
  it('accepts the file if and only if whenOmitted is absent, or useRecorded or skip with optional: true', () => {
    fc.assert(
      fc.property(whenOmittedArb, optionalArb, fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/), (whenOmitted, optional, name) => {
        const variable: Record<string, unknown> = { name };
        if (optional !== undefined) variable.optional = optional;
        if (whenOmitted !== undefined) variable.whenOmitted = whenOmitted;
        const valid = whenOmitted === undefined || ((whenOmitted === 'useRecorded' || whenOmitted === 'skip') && optional === true);
        let message: string | undefined;
        let loaded;
        try {
          loaded = deserializeWorkflowSet(fileWith(variable));
        } catch (error) {
          message = (error as Error).message;
        }
        if (valid) {
          expect(message).toBeUndefined();
          expect(loaded?.workflows[0].variables[0].whenOmitted).toBe(whenOmitted);
        } else {
          expect(loaded).toBeUndefined();
          expect(message).toContain(ID);
          expect(message).toContain(name);
        }
      }),
      { numRuns: 200 },
    );
  });
});