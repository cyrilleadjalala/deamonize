import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isHttpOnly, planSteps, type HttpRecipeLike, type PlanStepLike, type StepMode } from '../../src/replay/runtime/http-replay.js';

/** The planning of the unfixed code, kept as the reference for the preservation property. */
function originalPlanSteps(steps: readonly PlanStepLike[]): StepMode[] {
  const PREPARATORY = new Set(['type', 'select', 'hover', 'scrollIntoView']);
  return steps.map((step, index) => {
    if (step.http !== undefined) return 'http';
    if (!PREPARATORY.has(step.actionType) || step.secretRef !== undefined || step.totp === true) return 'ui';
    const later = steps.slice(index + 1).filter((s) => s.http !== undefined);
    if (later.length === 0) return 'ui';
    if (step.variable === undefined) return 'prep';
    return later.some((s) => (s.http?.bindings ?? []).some((b) => b.variable === step.variable)) ? 'prep' : 'ui';
  });
}

const VARIABLES = ['q', 'r', 'code'];

const recipeArb: fc.Arbitrary<HttpRecipeLike> = fc.record({
  method: fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
  url: fc.constant('http://app.test/api/x'),
  query: fc.constant({}),
  bindings: fc.array(
    fc.constantFrom(...VARIABLES).map((variable) => ({ variable, in: 'query', name: 'q' })),
    { maxLength: 2 }
  ),
  auth: fc.constantFrom(undefined, 'none', 'storageState', 'env:TOKEN'),
});

const stepArb: fc.Arbitrary<PlanStepLike> = fc.record(
  {
    actionType: fc.constantFrom('type', 'click', 'select', 'hover', 'scrollIntoView', 'switch_page'),
    variable: fc.constantFrom(...VARIABLES),
    secretRef: fc.constantFrom('PW'),
    totp: fc.boolean(),
    http: recipeArb,
  },
  { requiredKeys: ['actionType'] }
);

const stepsArb = fc.array(stepArb, { maxLength: 8 });

/** isBugCondition_2: a recipe or prep step in the raw plan with a ui step after it. */
function isBugCondition(steps: readonly PlanStepLike[]): boolean {
  const raw = originalPlanSteps(steps);
  return raw.some((mode, i) => mode !== 'ui' && raw.slice(i + 1).includes('ui'));
}

describe('planSteps (nextjs-spa-replay-fixes, Bug 2)', () => {
  // Feature: nextjs-spa-replay-fixes, Property 3: Bug Condition - Nothing runs over HTTP before a browser step
  // **Validates: Requirements 2.5, 2.6, 2.7, 2.8**
  it('Property 3: no http or prep step has a ui step after it', () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const plan = planSteps(steps);
        expect(plan).toHaveLength(steps.length);
        plan.forEach((mode, i) => {
          if (mode !== 'ui') expect(plan.slice(i + 1)).not.toContain('ui');
        });
        // A recipe that relies on the browser cookies is a browser step in a plan that has one
        const raw = originalPlanSteps(steps);
        if (raw.includes('ui')) {
          steps.forEach((step, i) => {
            if (step.http?.auth === 'storageState') expect(plan[i]).toBe('ui');
          });
        }
        // The final suffix keeps its raw mode
        const lastUi = plan.lastIndexOf('ui');
        plan.forEach((mode, i) => {
          if (i > lastUi) expect(mode).toBe(raw[i]);
        });
      }),
      { numRuns: 200 }
    );
  });

  it('plans the credentials / code / verify workflow entirely on the page', () => {
    const post = (variable: string, auth?: string): HttpRecipeLike => ({
      method: 'POST',
      url: 'http://app.test/api/auth/login/credentials',
      query: {},
      bindings: [{ variable, in: 'body', name: `/${variable}` }],
      auth,
    });
    const steps: PlanStepLike[] = [
      { actionType: 'type', variable: 'email' },
      { actionType: 'type', variable: 'password' },
      { actionType: 'click', http: post('password', 'none') },
      { actionType: 'type', secretRef: 'TOTP', totp: true },
      { actionType: 'click', http: post('code', 'storageState') },
    ];
    expect(planSteps(steps)).toEqual(['ui', 'ui', 'ui', 'ui', 'ui']);
  });

  // Feature: nextjs-spa-replay-fixes, Property 4: Preservation - HTTP-only and recipe-free workflows plan as before
  // **Validates: Requirements 3.5, 3.6, 3.7**
  it('Property 4: lists outside the bug condition plan as the original did', () => {
    fc.assert(
      fc.property(
        stepsArb.filter((steps) => !isBugCondition(steps) && !(originalPlanSteps(steps).includes('ui') && steps.some((s) => s.http?.auth === 'storageState'))),
        (steps) => {
          expect(planSteps(steps)).toEqual(originalPlanSteps(steps));
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: nextjs-spa-replay-fixes, Property 4: Preservation - HTTP-only and recipe-free workflows plan as before
  // **Validates: Requirements 3.5, 3.6**
  it('Property 4: a workflow with no recipe is all ui, an all-recipe/prep workflow is HTTP only', () => {
    fc.assert(
      fc.property(fc.array(stepArb.map(({ http: _http, ...rest }) => rest), { maxLength: 8 }), (steps) => {
        expect(planSteps(steps).every((mode) => mode === 'ui')).toBe(true);
      }),
      { numRuns: 100 }
    );
    fc.assert(
      fc.property(fc.array(recipeArb, { minLength: 1, maxLength: 5 }), (recipes) => {
        const steps: PlanStepLike[] = recipes.map((http) => ({ actionType: 'click', http }));
        const plan = planSteps(steps);
        expect(plan.every((mode) => mode === 'http')).toBe(true);
        expect(isHttpOnly(plan)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: nextjs-spa-replay-fixes, Property 4: Preservation - HTTP-only and recipe-free workflows plan as before
  // **Validates: Requirements 3.6, 3.7**
  it('Property 4: a secret, a TOTP step and a non-preparatory step stay ui', () => {
    const recipe: HttpRecipeLike = { method: 'GET', url: 'http://app.test/api/x', query: {}, bindings: [{ variable: 'q', in: 'query', name: 'q' }] };
    fc.assert(
      fc.property(
        fc.constantFrom<PlanStepLike>(
          { actionType: 'type', variable: 'q', secretRef: 'PW' },
          { actionType: 'type', secretRef: 'SEED', totp: true },
          { actionType: 'click' },
          { actionType: 'switch_page' }
        ),
        (blocker) => {
          expect(planSteps([blocker, { actionType: 'click', http: recipe }])).toEqual(['ui', 'http']);
        }
      )
    );
  });
});
