// Feature: kiro-native-agent-and-firewall, Property 31: Risk and write steps are embedded once and deterministically
// **Validates: Requirements 11.1, 11.12, 28.8**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { McpGenerator, buildFirewallMeta } from '../../src/compiler/mcp-generator.js';
import { deriveToolNames } from '../../src/compiler/tool-name-deriver.js';
import { toolRiskOf, writeStepsOf } from '../../src/studio/model.js';
import { FW_MARK } from '../../src/compiler/firewall-markers.js';
import type { Workflow, WorkflowSet, WorkflowStep } from '../../src/types.js';

const stepArb: fc.Arbitrary<WorkflowStep> = fc.record({
  actionType: fc.constantFrom('click', 'type', 'select'),
  selectors: fc.constant(['#x']),
  label: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
  risk: fc.option(fc.constantFrom('read' as const, 'write' as const, 'delete' as const), { nil: undefined }),
}).map((step) => (step.label === undefined ? { actionType: step.actionType, selectors: step.selectors, ...(step.risk === undefined ? {} : { risk: step.risk }) } : step));

const setArb: fc.Arbitrary<WorkflowSet> = fc
  .array(fc.array(stepArb, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 4 })
  .map((all) => ({
    version: '1',
    targetType: 'web',
    targetName: 'Fixture App',
    startUrl: 'http://localhost:8080/',
    workflows: all.map((steps, i): Workflow => ({
      id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      label: `Task ${i} ${steps.length}`,
      steps,
      variables: [],
      observedPayloads: [],
    })),
  }));

const tableOf = (text: string): string => {
  const lines = text.split('\n').filter((line) => line.startsWith('const FIREWALL =') && line.trimEnd().endsWith(FW_MARK));
  expect(lines).toHaveLength(1);
  return lines[0];
};

describe('the embedded firewall table', () => {
  it('holds toolRiskOf and writeStepsOf of each tool once, and is the same for any order of the workflows', () => {
    fc.assert(
      fc.property(setArb, fc.nat(), (set, shift) => {
        const generator = new McpGenerator();
        const names = deriveToolNames(set, {});
        const text = generator.generate(set, names);
        const line = tableOf(text);
        const table = JSON.parse(line.slice('const FIREWALL ='.length, line.lastIndexOf(';')));
        for (const workflow of set.workflows) {
          const entry = table.tools[names.get(workflow.id) as string];
          expect(entry.risk).toBe(toolRiskOf(workflow));
          expect(entry.writeSteps).toEqual(writeStepsOf(workflow).writeSteps.map((w) => ({ index: w.index, label: w.label, risk: w.risk })));
          expect(entry.steps).toHaveLength(workflow.steps.length);
        }
        expect(Object.keys(table.tools).sort()).toEqual(Object.keys(table.tools));
        // Twice: equal bytes
        expect(generator.generate(set, names)).toBe(text);
        // A permutation of the workflows: the same table
        const rotated = [...set.workflows.slice(shift % set.workflows.length), ...set.workflows.slice(0, shift % set.workflows.length)];
        expect(JSON.stringify(buildFirewallMeta({ ...set, workflows: rotated }, names))).toBe(JSON.stringify(buildFirewallMeta(set, names)));
        // The descriptions and schemas of the tools do not come from the table
        const unmarked = text.split('\n').filter((l) => !l.trimEnd().endsWith(FW_MARK)).join('\n');
        expect(unmarked).not.toContain('FIREWALL');
      }),
      { numRuns: 100 }
    );
  });
});
