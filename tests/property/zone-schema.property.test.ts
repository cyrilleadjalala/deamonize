import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { ResultZone, WorkflowSet } from '../../src/types.js';
import { webZone } from '../helpers/zone-arbitraries.js';

const RUNS = { numRuns: 100 };

function setWith(zones: ResultZone[]): WorkflowSet {
  return {
    version: '1',
    targetType: 'web',
    targetName: 'Zone app',
    startUrl: 'https://zone.example.test/start',
    workflows: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        label: 'Zone action',
        steps: zones.map((z) => ({ actionType: 'click' as const, selectors: ['button'], resultZone: z })),
        variables: [],
        observedPayloads: [],
      },
    ],
  };
}

const ZONE_PATH = 'workflows/0/steps/0/resultZone';
const rejectionOf = (zone: unknown): string => {
  try {
    serializeWorkflowSet(setWith([zone as ResultZone]));
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

describe('result zone schema', () => {
  // Feature: result-zone-selector-robustness, Property 18: Serialization round trip
  // **Validates: Requirements 1.7, 7.1, 7.2, 11.5**
  it('Property 18: serialization round trip', () => {
    fc.assert(
      fc.property(fc.array(webZone, { minLength: 1, maxLength: 4 }), (zones) => {
        const set = setWith(zones);
        const text = serializeWorkflowSet(set);
        expect(deserializeWorkflowSet(text)).toEqual(set);
        expect(serializeWorkflowSet(deserializeWorkflowSet(text))).toBe(text);
        // A zone with neither new field serializes as the text produced before the change.
        const old = setWith(zones.map(({ selector, extractor }) => ({ selector, extractor })));
        expect(serializeWorkflowSet(old)).toBe(JSON.stringify(old, null, 2));
      }),
      RUNS
    );
  });

  // Feature: result-zone-selector-robustness, Property 19: Bounds are enforced
  // **Validates: Requirements 7.1, 7.2, 10.6**
  it('Property 19: bounds are enforced', () => {
    const okText = fc.stringMatching(/^[a-z#.]{1,20}$/);
    const badSelectors: fc.Arbitrary<unknown[]> = fc.oneof(
      fc.constant<unknown[]>([]),
      fc.array(okText, { minLength: 6, maxLength: 8 }),
      fc.array(okText, { minLength: 1, maxLength: 4 }).map((l) => ['', ...l].slice(0, 5)),
      fc.integer({ min: 301, max: 400 }).map((n) => ['a'.repeat(n)]),
      fc.constantFrom<unknown[]>([1], [null], [{}], ['a', 5])
    );
    const goodFp = { tag: 'table', kind: 'table', count: 3 };
    const badFingerprints: fc.Arbitrary<unknown> = fc.oneof(
      fc.constantFrom('Table', '1div', '', 'a b', 'x'.repeat(40)).map((tag) => ({ ...goodFp, tag })),
      fc.constantFrom('unknown', 'Text', '', 7).map((kind) => ({ ...goodFp, kind })),
      fc.integer({ min: -5, max: 0 }).map((count) => ({ ...goodFp, count })),
      fc.double({ min: 1.1, max: 50, noInteger: true }).map((count) => ({ ...goodFp, count })),
      okText.map((k) => ({ ...goodFp, [`extra${k}`]: 1 })),
      fc.constant({ kind: 'table' }),
      fc.constant('table')
    );
    const base: ResultZone = { selector: 'div', extractor: { kind: 'text' } };

    fc.assert(
      fc.property(
        fc.oneof(
          badSelectors.map((selectors) => ({ field: 'selectors', zone: { ...base, selectors } })),
          badFingerprints.map((fingerprint) => ({ field: 'fingerprint', zone: { ...base, fingerprint } }))
        ),
        ({ field, zone }) => {
          const message = rejectionOf(zone);
          expect(message).not.toBe('');
          expect(message).toContain(`${ZONE_PATH}/${field}`);
        }
      ),
      RUNS
    );
  });
});
