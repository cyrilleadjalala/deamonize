// Feature: user-journey-improvements, Property 25: A rename reaches every place
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { renameVariable, type VariableHost } from '../../src/workflow/variable-edit.js';
import type { WorkflowStep } from '../../src/types.js';
import { buildRecipe, recipePlaceArb, variableNameArb, type RecipePlace } from '../helpers/workflow-arbitraries.js';

/** The host the Studio edits, built from the names: renaming one name must give the host built with the new name. */
function buildHost(names: string[], places: RecipePlace[]): VariableHost {
  const steps: WorkflowStep[] = [
    ...names.map((name): WorkflowStep => ({ actionType: 'type', selectors: ['input'], variable: name, value: 'v' })),
    { actionType: 'click', selectors: ['button'], rowBinding: { container: { role: 'row' }, key: { text: 'Row' }, variable: names[0] } },
    { actionType: 'click', selectors: ['button'], http: buildRecipe(names, places) },
  ];
  return {
    steps,
    variables: names.map((name) => ({ name })),
    observedPayloads: [Object.fromEntries(names.map((name, i) => [name, `value ${i}`])), Object.fromEntries(names.map((name) => [name, 1]))],
  };
}

describe('Property 25: A rename reaches every place', () => {
  /** **Validates: Requirements 14.13** */
  it('every reference to the old name uses the new name and every other name is unchanged', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(variableNameArb, { minLength: 2, maxLength: 5 }),
        variableNameArb,
        fc.array(recipePlaceArb(true), { minLength: 5, maxLength: 5 }),
        fc.nat(),
        (names, candidate, places, pick) => {
          const index = pick % names.length;
          fc.pre(!names.includes(candidate));
          const to = candidate;
          const host = buildHost(names, places);
          renameVariable(host, names[index], to);
          const renamed = names.map((name, i) => (i === index ? to : name));
          expect(host).toEqual(buildHost(renamed, places));
          // the old name is gone from every place: no `{{old}}`, no `$var` of it, no key, no binding
          const text = JSON.stringify(host);
          expect(text).not.toContain(`{{${names[index]}}}`);
          expect(text).not.toContain(`"$var":"${names[index]}"`);
          expect(text).not.toContain(`"variable":"${names[index]}"`);
          expect(text).not.toContain(`"name":"${names[index]}"`);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('keeps the order of the payload keys and changes nothing for the same name', () => {
    const host = buildHost(['a', 'b'], ['query', 'body', 'header', 'path', 'query']);
    const before = structuredClone(host);
    renameVariable(host, 'a', 'a');
    expect(host).toEqual(before);
    renameVariable(host, 'a', 'z');
    expect(Object.keys(host.observedPayloads[0])).toEqual(['z', 'b']);
  });
});