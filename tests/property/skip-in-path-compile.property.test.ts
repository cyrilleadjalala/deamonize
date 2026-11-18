// Feature: user-journey-improvements, Property 8: A skipped Variable in a path is refused
// **Validates: Requirements 3.7**
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Compiler } from '../../src/compiler/compiler.js';
import { SKIP_IN_PATH_MESSAGE, findSkippedPathBinding } from '../../src/workflow/workflow-scope.js';
import type { WorkflowSet, WorkflowVariable } from '../../src/types.js';
import { buildRecipe, recipePlaceArb, variableNamesArb, type RecipePlace } from '../helpers/workflow-arbitraries.js';
import { removeDir } from '../helpers/cleanup.js';

let parent = '';
let counter = 0;
beforeAll(async () => {
  parent = await mkdtemp(join(tmpdir(), 'daemonize-skippath-'));
});
afterAll(async () => {
  await removeDir(parent);
});

function setOf(names: string[], places: RecipePlace[], skipped: boolean[]): WorkflowSet {
  const variables: WorkflowVariable[] = names.map((name, index) => ({ name, optional: true, ...(skipped[index] ? { whenOmitted: 'skip' as const } : {}) }));
  return {
    version: '1',
    targetType: 'web',
    targetName: 'Skip Path',
    startUrl: 'https://app.test/',
    workflows: [
      {
        id: 'a1111111-1111-4111-8111-111111111111',
        label: 'Call',
        steps: [{ actionType: 'click', selectors: ['#go'], http: buildRecipe(names, places) }],
        variables,
        observedPayloads: [],
      },
    ],
  };
}

describe('Property 8: A skipped Variable in a path is refused', () => {
  it('--http auto refuses with the same message as the helper and writes no file', async () => {
    await fc.assert(
      fc.asyncProperty(
        variableNamesArb(1, 4).chain((names) =>
          fc.tuple(
            fc.constant(names),
            fc.array(recipePlaceArb(true), { minLength: names.length, maxLength: names.length }),
            fc.array(fc.boolean(), { minLength: names.length, maxLength: names.length }),
          ),
        ),
        async ([names, drawnPlaces, drawnSkipped]) => {
          // The first Variable is always skipped and in the path: a set that compiles is covered by the unit tests
          const places = drawnPlaces.map((place, index) => (index === 0 ? ('path' as const) : place));
          const skipped = drawnSkipped.map((value, index) => index === 0 || value);
          const set = setOf(names, places, skipped);
          const hit = findSkippedPathBinding(set.workflows[0]);
          const expected = names.some((_, index) => places[index] === 'path' && skipped[index]);
          expect(hit !== undefined).toBe(expected);
          const out = join(parent, `out-${counter++}`);
          const log = console.log;
          console.log = () => undefined;
          try {
            await new Compiler().compile(set, out, { http: 'auto' });
            expect(hit).toBeUndefined();
          } catch (error) {
            expect(hit).toBeDefined();
            expect((error as Error).message).toBe(SKIP_IN_PATH_MESSAGE(set.workflows[0].id, hit!.variable));
            expect(existsSync(out)).toBe(false);
          } finally {
            console.log = log;
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 120000);
});
