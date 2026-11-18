// Feature: user-journey-improvements, Property 9: The Skip_List embedded in generated code
// **Validates: Requirements 4.1, 4.2, 4.3, 4.8, 10.9**
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { skipListOf, usesWorkflowCall } from '../../src/workflow/workflow-scope.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';
import { workflowSetArb, skipVariableArb, variableNameArb } from '../helpers/workflow-arbitraries.js';

/** The workflow set with some Skip_List Variables added to its workflows. */
const setWithSkipsArb: fc.Arbitrary<WorkflowSet> = workflowSetArb().chain((set) =>
  fc
    .array(fc.uniqueArray(variableNameArb, { maxLength: 3 }), { minLength: set.workflows.length, maxLength: set.workflows.length })
    .chain((namesPerWorkflow) =>
      fc.tuple(...namesPerWorkflow.map((names) => fc.tuple(...names.map((name) => skipVariableArb(name))))).map((variablesPerWorkflow) => {
        const copy: WorkflowSet = structuredClone(set);
        copy.workflows.forEach((workflow, index) => {
          const added = variablesPerWorkflow[index];
          const known = new Set(workflow.variables.map((variable) => variable.name));
          workflow.variables = [...workflow.variables, ...added.filter((variable) => !known.has(variable.name))];
        });
        return copy;
      }),
    ),
);

const toolNamesOf = (set: WorkflowSet): Map<string, string> => new Map(set.workflows.map((workflow, index) => [workflow.id, `tool_${index}`]));

/** The text of one tool block of the generated server. */
function blockOf(server: string, toolName: string): string {
  const start = server.indexOf(`// Tool: ${toolName} `);
  const next = server.indexOf('// Tool: ', start + 1);
  return server.slice(start, next === -1 ? undefined : next);
}

function expectedCall(workflow: Workflow): string {
  const call: Record<string, unknown> = {};
  const skip = skipListOf(workflow);
  if (skip.length > 0) call.skip = skip;
  if (workflow.startUrl !== undefined) call.startUrl = workflow.startUrl;
  if (workflow.storageState !== undefined) call.storageState = workflow.storageState;
  return Object.keys(call).length === 0 ? '' : JSON.stringify(call);
}

describe('Property 9: The Skip_List embedded in generated code', () => {
  it('each tool call holds its Skip_List names once each in workflow order, and nothing else of the steps', () => {
    fc.assert(
      fc.property(setWithSkipsArb, (set) => {
        const names = toolNamesOf(set);
        const server = new McpGenerator().generate(set, names);
        const withCall = usesWorkflowCall(set);
        for (const workflow of set.workflows) {
          const block = blockOf(server, names.get(workflow.id) as string);
          const call = withCall ? expectedCall(workflow) : '';
          const skip = skipListOf(workflow);
          expect(new Set(skip).size).toBe(skip.length);
          if (call === '') expect(block).toMatch(/setMs: [^}]*\}\);/);
          else expect(block).toContain(`${call});`);
          if (skip.length > 0) {
            const embedded = JSON.parse(call) as { skip: string[] };
            expect(embedded.skip).toEqual(skip);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a set with no Skip_List, start page or login generates no call parameter in any file', () => {
    fc.assert(
      fc.property(workflowSetArb(), (generated) => {
        const set = structuredClone(generated);
        for (const workflow of set.workflows) {
          delete workflow.startUrl;
          delete workflow.storageState;
          workflow.variables = workflow.variables.map((variable) => ({ ...variable, whenOmitted: variable.whenOmitted === 'skip' ? 'useRecorded' : variable.whenOmitted }));
        }
        expect(usesWorkflowCall(set)).toBe(false);
        const generator = new McpGenerator();
        const texts = [generator.generate(set, toolNamesOf(set)), generator.generateReplay(set), generator.generateDockerReplay(set, 'img')];
        for (const text of texts) expect(text).not.toMatch(/WorkflowCall|omission|skippedSet|skippedSteps/);
      }),
      { numRuns: 100 },
    );
  });

  it('a set that uses a call gets planSkips and the call parameter in replay.ts and docker-replay.ts', () => {
    fc.assert(
      fc.property(setWithSkipsArb, (set) => {
        fc.pre(usesWorkflowCall(set));
        const generator = new McpGenerator();
        expect(generator.generateReplay(set)).toContain('planSkips(steps, args, call.skip)');
        expect(generator.generateDockerReplay(set, 'img')).toContain('call: WorkflowCall = {}');
        expect(generator.generateSandboxFiles(set).copy).toContain('omission.js');
      }),
      { numRuns: 100 },
    );
  });
});
