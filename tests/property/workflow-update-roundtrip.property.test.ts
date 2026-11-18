// Feature: user-journey-improvements, Property 27: Update then inverse update
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyUpdate } from '../../src/studio/workflow-editor.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';
import type { WorkflowSet } from '../../src/types.js';

type Plan = { rename: boolean; flip: boolean; optionalNow: boolean; whenNow: 'useRecorded' | 'skip' };
const planArb: fc.Arbitrary<Plan> = fc.record({
  rename: fc.boolean(),
  flip: fc.boolean(),
  optionalNow: fc.boolean(),
  whenNow: fc.constantFrom('useRecorded' as const, 'skip' as const),
});

/** The first workflow gets numeric payloads and one step per Variable, so renames and retypes touch real places. */
function prepare(set: WorkflowSet): WorkflowSet {
  const next = structuredClone(set);
  const workflow = next.workflows[0];
  workflow.observedPayloads = [Object.fromEntries(workflow.variables.map((v) => [v.name, v.type === 'number' ? 7 : v.type === 'boolean' ? false : '42']))];
  for (const variable of workflow.variables) workflow.steps.push({ actionType: 'type', selectors: ['role=textbox'], variable: variable.name, value: 'x' });
  return next;
}

/** RC-4: an absent type is text, `optional: false` is absent, an optional Variable without whenOmitted uses the recorded value. */
function canonical(set: WorkflowSet): unknown {
  const copy = structuredClone(set);
  for (const workflow of copy.workflows) {
    workflow.variables = workflow.variables.map((v) => {
      const out: Record<string, unknown> = { ...v, type: v.type ?? 'string' };
      if (v.optional === true) out.whenOmitted = v.whenOmitted ?? 'useRecorded';
      else {
        delete out.optional;
        delete out.whenOmitted;
      }
      return out as unknown as typeof v;
    });
  }
  return copy;
}

describe('Property 27: Update then inverse update', () => {
  it('returns to the original content (compared in canonical form) after the inverse update', () => {
    fc.assert(
      fc.property(workflowSetArb(), fc.array(planArb, { minLength: 1, maxLength: 4 }), (generated, plans) => {
        const set = prepare(generated);
        const target = set.workflows[0];
        fc.pre(target.variables.length > 0);
        const forward: Array<Record<string, unknown>> = [];
        const inverse: Array<Record<string, unknown>> = [];
        target.variables.forEach((variable, i) => {
          const plan = plans[i % plans.length];
          const type = variable.type ?? 'string';
          const to = !plan.flip || type === 'boolean' ? type : type === 'string' ? 'number' : 'string';
          const newName = plan.rename ? `${variable.name}_tmp` : variable.name;
          const forwardObject: Record<string, unknown> = { name: variable.name, newName, type: to, optional: plan.optionalNow };
          if (plan.optionalNow) forwardObject.whenOmitted = plan.whenNow;
          forward.push(forwardObject);
          const back: Record<string, unknown> = { name: newName, newName: variable.name, type, optional: variable.optional === true };
          if (variable.optional === true) back.whenOmitted = variable.whenOmitted ?? 'useRecorded';
          inverse.push(back);
        });
        const first = applyUpdate(set, { id: target.id, variables: forward });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = applyUpdate(first.value, { id: target.id, variables: inverse });
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(canonical(second.value)).toEqual(canonical(set));
      }),
      { numRuns: 100 },
    );
  });
});
