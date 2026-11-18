// Feature: user-journey-improvements, Property 13: A check step holds true or false
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';

function fileWith(value: string): string {
  return JSON.stringify({
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'https://app.test/',
    workflows: [
      {
        id: '55555555-5555-4555-8555-555555555555',
        label: 'Action',
        steps: [{ actionType: 'check', selectors: ['input'], value }],
        variables: [],
        observedPayloads: [],
      },
    ],
  });
}

describe('Property 13: A check step holds true or false', () => {
  /** **Validates: Requirements 7.2** */
  it('accepts a check step if and only if its value is "true" or "false"', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('true', 'false', 'True', 'FALSE', 'true ', ' false', '1', '0', '')), (value) => {
        let accepted = true;
        try {
          deserializeWorkflowSet(fileWith(value));
        } catch {
          accepted = false;
        }
        expect(accepted).toBe(value === 'true' || value === 'false');
      }),
      { numRuns: 200 },
    );
  });
});