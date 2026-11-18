// Feature: user-journey-improvements, Property 16: Radio group validity (schema part)
// **Validates: Requirements 8.14**
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import { variableNameArb } from '../helpers/workflow-arbitraries.js';
import type { WorkflowSet } from '../../src/types.js';

const radioNamesArb = fc.uniqueArray(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,18}$/), { minLength: 2, maxLength: 50 });

describe('Property 16: Radio group validity (schema part)', () => {
  it('the allowed values of a radio Variable equal its enum and required follows optional', () => {
    fc.assert(
      fc.property(variableNameArb, radioNamesArb, fc.boolean(), fc.option(fc.constantFrom<'useRecorded' | 'skip'>('useRecorded', 'skip'), { nil: undefined }), (name, names, optional, whenOmitted) => {
        const set: WorkflowSet = {
          version: '1',
          targetType: 'web',
          targetName: 'Radio',
          startUrl: 'https://app.test/',
          workflows: [
            {
              id: 'a1111111-1111-4111-8111-111111111111',
              label: 'Pick',
              steps: [{ actionType: 'click', selectors: ['input[type=radio]'], value: names[0], variable: name }],
              variables: [{ name, type: 'string', enum: names, optional, ...(optional && whenOmitted !== undefined ? { whenOmitted } : {}) }],
              observedPayloads: [{ [name]: names[0] }],
            },
          ],
        };
        const schema = new SchemaInferencer().inferWorkflows(set).workflows[0].inputSchema as {
          properties: Record<string, { type: string; enum?: string[] }>;
          required: string[];
        };
        expect(schema.properties[name].type).toBe('string');
        expect(schema.properties[name].enum).toEqual(names);
        expect(schema.required.includes(name)).toBe(!optional);
      }),
      { numRuns: 100 },
    );
  });
});
