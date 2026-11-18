// Feature: user-journey-improvements, Property 15: Check steps are preparatory
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planSteps, type PlanStepLike } from '../../src/replay/runtime/http-replay.js';
import { healEligible, type StepLike } from '../../src/replay/runtime/step-plan.js';

const http = (variable?: string): PlanStepLike => ({
  actionType: 'click',
  http: { method: 'POST', url: 'https://a.test/x', query: {}, bindings: variable === undefined ? [] : [{ variable, in: 'body', name: variable }] },
});

describe('Property 15: Check steps are preparatory', () => {
  /** **Validates: Requirements 7.9** */
  it('a check step is prep when a later recipe takes its Variable or it has none, ui otherwise', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom('a', 'b'), { nil: undefined }),
        fc.option(fc.constantFrom('a', 'b'), { nil: undefined }),
        fc.boolean(),
        (checkVar, boundVar, hasLater) => {
          const steps: PlanStepLike[] = [{ actionType: 'check', ...(checkVar === undefined ? {} : { variable: checkVar }) }];
          if (hasLater) steps.push(http(boundVar));
          const expected = !hasLater ? 'ui' : checkVar === undefined || checkVar === boundVar ? 'prep' : 'ui';
          expect(planSteps(steps)[0]).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 7.10** */
  it('a check step is never eligible for healing, whatever the mode, risk or opt-in', () => {
    fc.assert(
      fc.property(fc.constantFrom('strict', 'heal'), fc.constantFrom('read', 'write', 'delete'), fc.boolean(), (mode, risk, allowHeal) => {
        const step = { actionType: 'check', selectors: ['input'], risk, allowHeal } as StepLike;
        expect(healEligible(step, mode as 'strict' | 'heal')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
