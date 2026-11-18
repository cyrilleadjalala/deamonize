// Feature: user-journey-improvements, Property 3: Description lead and limits
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';

const ID = '44444444-4444-4444-8444-444444444444';

function fileWith(description: unknown): string {
  return JSON.stringify({
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'https://app.test/',
    workflows: [{ id: ID, label: 'Action', description, steps: [{ actionType: 'click', selectors: ['button'] }], variables: [], observedPayloads: [] }],
  });
}

describe('Property 3: Description lead and limits (loader part)', () => {
  /** **Validates: Requirements 1.6, 1.7, 1.8** */
  it('accepts any string of 0 to 1000 characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (description) => {
        expect(deserializeWorkflowSet(fileWith(description)).workflows[0].description).toBe(description);
      }),
      { numRuns: 100 },
    );
  });

  it('refuses a longer string or a non-string with an error that names the workflow id', () => {
    const tooLong = fc.string({ minLength: 1001, maxLength: 1100 });
    const notAString = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string(), { maxLength: 2 }), fc.constant({}));
    fc.assert(
      fc.property(fc.oneof(tooLong, notAString), (description) => {
        let message = '';
        try {
          deserializeWorkflowSet(fileWith(description));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain(ID);
      }),
      { numRuns: 100 },
    );
  });
});