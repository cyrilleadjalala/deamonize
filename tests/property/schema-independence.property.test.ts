// Feature: user-journey-improvements, Property 4: The input schema ignores whenOmitted and description
// **Validates: Requirements 1.9, 1.10, 8.14**
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { workflowSetArb } from '../helpers/workflow-arbitraries.js';

const valueArb = fc.constantFrom<'useRecorded' | 'skip' | undefined>('useRecorded', 'skip', undefined);

/** A copy of the set with every optional Variable given another whenOmitted, and every workflow another description. */
function changed(set: WorkflowSet, whenOmitted: 'useRecorded' | 'skip' | undefined, description: string | undefined): WorkflowSet {
  const copy = structuredClone(set);
  for (const workflow of copy.workflows) {
    if (description === undefined) delete workflow.description;
    else workflow.description = description;
    for (const variable of workflow.variables) {
      if (variable.optional !== true) continue;
      if (whenOmitted === undefined) delete variable.whenOmitted;
      else variable.whenOmitted = whenOmitted;
    }
  }
  return copy;
}

/** The lines of the generated server that come from the input schema of the tools. */
function schemaLines(server: string): string[] {
  return server.split('\n').filter((line) => line.startsWith('const INPUT_SCHEMAS') || /^\s+"[^"]+": z\./.test(line));
}

describe('Property 4: The input schema ignores whenOmitted and description', () => {
  it('the inferred schema, the zod schema and the required list do not change', () => {
    fc.assert(
      fc.property(workflowSetArb(), valueArb, valueArb, fc.option(fc.string({ maxLength: 80 }), { nil: undefined }), (set, first, second, description) => {
        const a = changed(set, first, undefined);
        const b = changed(set, second, description);
        const inferred = new SchemaInferencer();
        const schemasA = inferred.inferWorkflows(a).workflows.map((workflow) => workflow.inputSchema);
        const schemasB = inferred.inferWorkflows(b).workflows.map((workflow) => workflow.inputSchema);
        expect(schemasB).toEqual(schemasA);
        const names = new Map(a.workflows.map((workflow, index) => [workflow.id, `tool_${index}`]));
        const generator = new McpGenerator();
        const serverA = generator.generate(inferred.inferWorkflows(a), names);
        const serverB = generator.generate(inferred.inferWorkflows(b), names);
        expect(schemaLines(serverB)).toEqual(schemaLines(serverA));
        // An optional Variable is never required, whatever happens when it is omitted
        for (const workflow of inferred.inferWorkflows(b).workflows) {
          const required = (workflow.inputSchema?.['required'] ?? []) as string[];
          for (const variable of workflow.variables) expect(required.includes(variable.name)).toBe(variable.optional !== true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
