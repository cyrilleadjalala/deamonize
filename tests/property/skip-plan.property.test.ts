// Feature: user-journey-improvements, Property 5: Skip planning
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planSkips, type SkippableStep } from '../../src/replay/runtime/omission.js';

const names = ['a', 'b', 'c', 'd'];
const nameArb = fc.constantFrom(...names);

const stepArb: fc.Arbitrary<SkippableStep> = fc
  .record({
    actionType: fc.constantFrom('click', 'type', 'select', 'check'),
    variable: fc.option(nameArb, { nil: undefined }),
    rowVariable: fc.option(nameArb, { nil: undefined }),
    secretRef: fc.option(fc.constant('APP_SECRET'), { nil: undefined }),
    totp: fc.option(fc.constant(true), { nil: undefined }),
    http: fc.option(fc.constant({ method: 'GET' }), { nil: undefined }),
  })
  .map(({ actionType, variable, rowVariable, secretRef, totp, http }) => {
    const step: SkippableStep = { actionType };
    if (variable !== undefined) step.variable = variable;
    if (rowVariable !== undefined) step.rowBinding = { variable: rowVariable };
    if (secretRef !== undefined) step.secretRef = secretRef;
    if (totp !== undefined) step.totp = totp;
    if (http !== undefined) step.http = http;
    return step;
  });

const valueArb = fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant(''), fc.constant(0), fc.constant(false), fc.string({ maxLength: 4 }), fc.integer());
const argsArb: fc.Arbitrary<Record<string, unknown>> = fc.record({ a: valueArb, b: valueArb, c: valueArb, d: valueArb }, { requiredKeys: [] });
const skipArb = fc.oneof(fc.constant(undefined), fc.array(fc.constantFrom(...names, 'unused'), { maxLength: 5 }));

describe('Property 5: Skip planning', () => {
  /** **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 4.6, 4.7** */
  it('skips a step if and only if it names an omitted Skip_List Variable and has no secretRef, totp or http', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 8 }), argsArb, skipArb, (steps, args, skip) => {
        const result = planSkips(steps, args, skip);
        expect([...result].sort((x, y) => x - y)).toEqual(result);
        expect(new Set(result).size).toBe(result.length);
        const omitted = (name: string | undefined): boolean =>
          name !== undefined && (skip ?? []).includes(name) && (args[name] === undefined || args[name] === null);
        const expected = steps.flatMap((step, index) =>
          step.secretRef === undefined && step.totp !== true && step.http === undefined && (omitted(step.variable) || omitted(step.rowBinding?.variable)) ? [index] : [],
        );
        expect(result).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('never skips for a supplied empty string, 0 or false, and ignores names no step uses', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 8 }), fc.constantFrom('', 0, false), (steps, supplied) => {
        const args = { a: supplied, b: supplied, c: supplied, d: supplied };
        expect(planSkips(steps, args, names)).toEqual([]);
        const base = planSkips(steps, {}, ['a']);
        expect(planSkips(steps, {}, ['a', 'unused'])).toEqual(base);
      }),
      { numRuns: 200 },
    );
  });

  it('plans nothing without a Skip_List', () => {
    expect(planSkips([{ actionType: 'type', variable: 'a' }], {}, undefined)).toEqual([]);
    expect(planSkips([{ actionType: 'type', variable: 'a' }], {}, [])).toEqual([]);
  });
});