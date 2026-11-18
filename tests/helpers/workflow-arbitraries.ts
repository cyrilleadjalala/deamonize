/**
 * Shared fast-check arbitraries of the user-journey-improvements properties.
 * They build valid Workflow sets with the new fields (Variable `whenOmitted`, workflow `description`, `startUrl`
 * and `storageState`, `check` steps). No generated value is a secret: names are plain words, no step types a password.
 */
import fc from 'fast-check';
import type { HttpRecipe, Workflow, WorkflowSet, WorkflowStep, WorkflowVariable } from '../../src/types.js';

export const variableNameArb: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,15}$/);

/** A list of distinct Variable names. */
export const variableNamesArb = (min = 0, max = 5): fc.Arbitrary<string[]> =>
  fc.uniqueArray(variableNameArb, { minLength: min, maxLength: max });

const textArb = fc.stringMatching(/^[a-z][a-z0-9 ]{0,18}$/);

/** A Variable with `type`, `optional` and `whenOmitted` each absent or valid (`whenOmitted` only with `optional: true`). */
export function variableArb(name?: string): fc.Arbitrary<WorkflowVariable> {
  return fc
    .record({
      name: name === undefined ? variableNameArb : fc.constant(name),
      type: fc.option(fc.constantFrom('string', 'number', 'boolean') as fc.Arbitrary<'string' | 'number' | 'boolean'>, { nil: undefined }),
      description: fc.option(textArb, { nil: undefined }),
      optional: fc.option(fc.boolean(), { nil: undefined }),
      whenOmitted: fc.option(fc.constantFrom('useRecorded', 'skip') as fc.Arbitrary<'useRecorded' | 'skip'>, { nil: undefined }),
    })
    .map((raw) => {
      const variable: WorkflowVariable = { name: raw.name };
      if (raw.type !== undefined) variable.type = raw.type;
      if (raw.description !== undefined) variable.description = raw.description;
      if (raw.optional !== undefined) variable.optional = raw.optional;
      if (raw.optional === true && raw.whenOmitted !== undefined) variable.whenOmitted = raw.whenOmitted;
      return variable;
    });
}

/** A Variable of the Skip_List: optional, whenOmitted skip. */
export const skipVariableArb = (name?: string): fc.Arbitrary<WorkflowVariable> =>
  variableArb(name).map((variable) => ({ ...variable, optional: true, whenOmitted: 'skip' as const }));

export type RecipePlace = 'query' | 'body' | 'header' | 'path';

export const recipePlaceArb = (allowPath = false): fc.Arbitrary<RecipePlace> =>
  fc.constantFrom(...(allowPath ? (['query', 'body', 'header', 'path'] as const) : (['query', 'body', 'header'] as const)));

/**
 * The recipe for the given names, one binding each, placed where `places[i]` says: `{{name}}` in the query, a header,
 * the path, or a `{"$var":name}` leaf plus a string leaf in the body. The same places with other names give the same shape.
 */
export function buildRecipe(names: readonly string[], places: readonly RecipePlace[]): HttpRecipe {
  const recipe: HttpRecipe = { method: 'POST', url: 'https://app.test/api/items', query: {}, body: {}, bodyFormat: 'json', headers: {}, bindings: [], redacted: [] };
  const body: Record<string, unknown> = {};
  names.forEach((name, i) => {
    const where = places[i];
    if (where === 'query') {
      recipe.query[`q${i}`] = `{{${name}}}`;
      recipe.bindings.push({ variable: name, in: 'query', name: `q${i}` });
    } else if (where === 'header') {
      recipe.headers![`x-h${i}`] = `value {{${name}}}`;
      recipe.bindings.push({ variable: name, in: 'header', name: `x-h${i}` });
    } else if (where === 'path') {
      recipe.url = `${recipe.url}/{{${name}}}`;
      recipe.bindings.push({ variable: name, in: 'path', name: String(i) });
    } else {
      body[`f${i}`] = { $var: name };
      body[`s${i}`] = `hello {{${name}}}`;
      recipe.bindings.push({ variable: name, in: 'body', name: `/f${i}` });
    }
  });
  recipe.body = body;
  return recipe;
}

/** A recipe whose url, query, headers and body mention the given Variable names (path bindings only when `allowPath`). */
export function recipeArb(names: string[], allowPath = false): fc.Arbitrary<HttpRecipe> {
  return fc.array(recipePlaceArb(allowPath), { minLength: names.length, maxLength: names.length }).map((places) => buildRecipe(names, places));
}

/** A step. `check` steps hold "true" or "false"; no step types a secret. */
export function stepArb(variable?: string): fc.Arbitrary<WorkflowStep> {
  return fc
    .record({
      actionType: fc.constantFrom('click', 'type', 'select', 'check') as fc.Arbitrary<'click' | 'type' | 'select' | 'check'>,
      selector: textArb,
      value: fc.constantFrom('true', 'false'),
      text: textArb,
    })
    .map(({ actionType, selector, value, text }) => {
      const step: WorkflowStep = { actionType, selectors: [`role=button[name="${selector}"]`] };
      if (actionType === 'check') step.value = value;
      else if (actionType !== 'click') step.value = text;
      if (variable !== undefined && actionType !== 'click') step.variable = variable;
      return step;
    });
}

const ORIGIN = 'https://app.example.com';

/** A workflow with new fields. `origin` is the origin of the set, so a per-workflow startUrl stays on it. */
export function workflowArb(origin: string = ORIGIN): fc.Arbitrary<Workflow> {
  return fc
    .record({
      id: fc.uuid(),
      label: textArb,
      description: fc.option(fc.string({ maxLength: 120 }), { nil: undefined }),
      startPath: fc.option(fc.stringMatching(/^[a-z0-9]{0,10}$/), { nil: undefined }),
      storageState: fc.option(fc.oneof(fc.constant(null), fc.stringMatching(/^[a-z][a-z0-9_.-]{0,20}\.json$/)), { nil: undefined }),
      variables: fc.uniqueArray(variableArb(), { selector: (variable) => variable.name, maxLength: 4 }),
    })
    .chain((raw) =>
      fc.array(stepArb(), { minLength: 1, maxLength: 4 }).map((steps) => {
        const workflow: Workflow = { id: raw.id, label: raw.label, steps, variables: raw.variables, observedPayloads: [] };
        if (raw.description !== undefined) workflow.description = raw.description;
        if (raw.startPath !== undefined) workflow.startUrl = `${origin}/${raw.startPath}`;
        if (raw.storageState !== undefined) workflow.storageState = raw.storageState;
        return workflow;
      }),
    );
}

/** A valid web Workflow set. */
export function workflowSetArb(origin: string = ORIGIN): fc.Arbitrary<WorkflowSet> {
  return fc
    .record({
      targetName: textArb,
      storageState: fc.option(fc.stringMatching(/^[a-z][a-z0-9_.-]{0,20}\.json$/), { nil: undefined }),
      workflows: fc.uniqueArray(workflowArb(origin), { selector: (workflow) => workflow.id, minLength: 1, maxLength: 3 }),
    })
    .map((raw) => {
      const set: WorkflowSet = { version: '1', targetType: 'web', targetName: raw.targetName, startUrl: origin, workflows: raw.workflows };
      if (raw.storageState !== undefined) set.storageState = raw.storageState;
      return set;
    });
}

/** A base set and a newer set of the same application, some workflow ids shared. */
export const workflowSetPairArb: fc.Arbitrary<{ base: WorkflowSet; newer: WorkflowSet }> = fc
  .tuple(workflowSetArb(), workflowSetArb(), fc.boolean())
  .map(([base, newer, share]) => {
    if (share) newer.workflows[0] = { ...newer.workflows[0], id: base.workflows[0].id };
    return { base, newer };
  });

/** A set in the form of an old file: none of the new fields anywhere. */
export const oldWorkflowSetArb: fc.Arbitrary<WorkflowSet> = fc
  .record({
    targetName: textArb,
    workflows: fc.uniqueArray(
      fc.record({ id: fc.uuid(), label: textArb, names: variableNamesArb(0, 3), selector: textArb }).map(({ id, label, names, selector }) => ({
        id,
        label,
        steps: [{ actionType: 'click' as const, selectors: [`role=button[name="${selector}"]`] }],
        variables: names.map((name, i): WorkflowVariable => (i === 0 ? { name, optional: true } : { name })),
        observedPayloads: [],
      })),
      { selector: (workflow) => workflow.id, minLength: 1, maxLength: 3 },
    ),
  })
  .map((raw): WorkflowSet => ({ version: '1', targetType: 'web', targetName: raw.targetName, startUrl: ORIGIN, workflows: raw.workflows }));
