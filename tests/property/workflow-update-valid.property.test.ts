// Feature: user-journey-improvements, Property 24: A valid update touches only what it names
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyUpdate } from '../../src/studio/workflow-editor.js';
import { deserializeWorkflowSet, serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';
import type { WorkflowSet, WorkflowVariable } from '../../src/types.js';

type VariableChange = { newName?: string; optional?: boolean; whenOmitted?: 'useRecorded' | 'skip'; description?: string; typeChange: boolean };
const WORDS = fc.stringMatching(/^[a-z][a-z ]{0,30}[a-z]$/);

/** Gives the first workflow numeric text payloads and a step per Variable so that renames and retypes have something to touch. */
function prepare(set: WorkflowSet): WorkflowSet {
  const next = structuredClone(set);
  const workflow = next.workflows[0];
  workflow.observedPayloads = [Object.fromEntries(workflow.variables.map((v) => [v.name, v.type === 'number' ? 7 : v.type === 'boolean' ? true : '42']))];
  for (const variable of workflow.variables) workflow.steps.push({ actionType: 'type', selectors: ['role=textbox'], variable: variable.name, value: 'x' });
  return next;
}

const changeArb: fc.Arbitrary<VariableChange> = fc.record(
  {
    newName: fc.constantFrom('', '_renamed'),
    optional: fc.boolean(),
    whenOmitted: fc.constantFrom('useRecorded' as const, 'skip' as const),
    description: fc.oneof(fc.constant(''), WORDS),
    typeChange: fc.boolean(),
  },
  { requiredKeys: [] },
);

describe('Property 24: A valid update touches only what it names', () => {
  it('changes the named fields and leaves everything else as loaded', () => {
    fc.assert(
      fc.property(
        workflowSetArb(),
        fc.option(WORDS, { nil: undefined }),
        fc.option(fc.oneof(fc.constant(''), WORDS), { nil: undefined }),
        fc.array(fc.option(changeArb, { nil: undefined }), { maxLength: 4 }),
        fc.boolean(),
        (generated, label, description, perVariable, padLabel) => {
          const set = prepare(generated);
          const target = set.workflows[0];
          const named = target.variables.map((v, i): [WorkflowVariable, VariableChange | undefined] => [v, perVariable[i]]);
          const objects = named.flatMap(([variable, change]) => {
            if (change === undefined) return [];
            const object: Record<string, unknown> = { name: variable.name };
            if (change.newName !== undefined) object.newName = `${variable.name}${change.newName}`;
            if (change.optional !== undefined) object.optional = change.optional;
            if (change.whenOmitted !== undefined && (change.optional ?? variable.optional === true)) object.whenOmitted = change.whenOmitted;
            if (change.description !== undefined) object.description = change.description;
            if (change.typeChange) object.type = (variable.type ?? 'string') === 'string' ? 'number' : (variable.type ?? 'string') === 'number' ? 'string' : 'boolean';
            return [object];
          });
          const request: Record<string, unknown> = { id: target.id };
          if (label !== undefined) request.label = padLabel ? `  ${label} ` : label;
          if (description !== undefined) request.description = description;
          if (objects.length > 0) request.variables = objects;
          fc.pre(Object.keys(request).length > 1);
          const before = structuredClone(set);
          const result = applyUpdate(set, request);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(set).toEqual(before);
          const out = result.value;
          // Everything outside the workflows, and the other workflows
          const { workflows: _a, ...restBefore } = before;
          const { workflows: _b, ...restAfter } = out;
          expect(restAfter).toEqual(restBefore);
          expect(out.workflows.slice(1)).toEqual(before.workflows.slice(1));
          // The fields the request does not name
          const after = out.workflows[0];
          const original = before.workflows[0];
          for (const key of ['id', 'startUrl', 'storageState', 'inputSchema', 'outputSchema', 'timeoutMs', 'finalScreenId', 'resultZone'] as const) {
            expect(after[key]).toEqual(original[key]);
          }
          expect(after.label).toBe(label === undefined ? original.label : label);
          if (description === undefined) expect(after.description).toBe(original.description);
          else if (description === '') expect('description' in after).toBe(false);
          else expect(typeof after.description).toBe('string');
          expect(after.steps.map((s) => [s.actionType, s.selectors, s.value])).toEqual(original.steps.map((s) => [s.actionType, s.selectors, s.value]));
          // Variables
          expect(after.variables).toHaveLength(original.variables.length);
          named.forEach(([variable, change], i) => {
            const got = after.variables[i];
            if (change === undefined) {
              expect(got).toEqual(variable);
              return;
            }
            expect(got.name).toBe(`${variable.name}${change.newName ?? ''}`);
            expect(got.optional === true).toBe(change.optional ?? variable.optional === true);
            if (got.optional !== true) expect('whenOmitted' in got).toBe(false);
            else if (change.whenOmitted !== undefined) expect(got.whenOmitted).toBe(change.whenOmitted);
            else expect(got.whenOmitted).toBe(variable.whenOmitted);
            if (change.description === undefined) expect(got.description).toBe(variable.description);
            if (change.description === '') expect('description' in got).toBe(false);
            if (!change.typeChange) expect(got.type).toBe(variable.type);
          });
          // The old names appear nowhere
          const renamed = named.filter(([, change]) => change?.newName === '_renamed').map(([variable]) => variable.name);
          const text = JSON.stringify(after);
          for (const old of renamed) expect(text).not.toContain(`"variable":"${old}"`);
          // The result is a loadable file
          expect(() => deserializeWorkflowSet(serializeWorkflowSet(out))).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('leaves the file as loaded when the variables change nothing (14.19, 14.20)', () => {
    fc.assert(
      fc.property(workflowSetArb(), (generated) => {
        const set = prepare(generated);
        const target = set.workflows[0];
        const objects = target.variables.map((v) => ({ name: v.name, newName: v.name }));
        fc.pre(objects.length > 0);
        const result = applyUpdate(set, { id: target.id, variables: objects });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toEqual(set);
      }),
      { numRuns: 100 },
    );
  });
});
