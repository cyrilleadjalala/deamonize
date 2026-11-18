// Feature: user-journey-improvements, Property 29: The workflow view of Variables
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NO_OUTPUTS, buildWorkflowView, displayUrl } from '../../src/studio/model.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';

describe('Property 29: The workflow view of Variables', () => {
  it('shows optional for every Variable and whenOmitted only for the optional ones, useRecorded when the file has none', () => {
    fc.assert(
      fc.property(workflowSetArb(), (set) => {
        for (const workflow of set.workflows) {
          const view = buildWorkflowView(set, workflow, NO_OUTPUTS);
          expect(view.variables.map((v) => v.name)).toEqual(workflow.variables.map((v) => v.name.slice(0, 60)));
          workflow.variables.forEach((variable, i) => {
            const shown = view.variables[i];
            expect(shown.optional).toBe(variable.optional === true);
            if (variable.optional === true) expect(shown.whenOmitted).toBe(variable.whenOmitted ?? 'useRecorded');
            else expect('whenOmitted' in shown).toBe(false);
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('shows the start page only when the workflow has its own start address', () => {
    fc.assert(
      fc.property(workflowSetArb(), (set) => {
        for (const workflow of set.workflows) {
          const view = buildWorkflowView(set, workflow, NO_OUTPUTS);
          if (workflow.startUrl === undefined || workflow.startUrl === set.startUrl) expect('startPage' in view).toBe(false);
          else expect(view.startPage).toBe(displayUrl(workflow.startUrl));
        }
      }),
      { numRuns: 100 },
    );
  });
});
