import { describe, it, expect } from 'vitest';
import { buildSelectors } from '../../src/recorder/selector-builder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import {
  serializeWorkflowSet,
  deserializeWorkflowSet,
  mergeWorkflowSets,
} from '../../src/workflow/workflow-set.js';
import { DescriptiveParseError } from '../../src/state/state-machine-builder.js';
import type { ScreenContent, WorkflowSet } from '../../src/types.js';

describe('buildSelectors', () => {
  it('orders role and name first, then stable attributes, then css', () => {
    expect(
      buildSelectors({ role: 'button', name: 'Save', id: 'save', css: 'form > button' })
    ).toEqual(['role=button[name="Save"]', '#save', 'form > button']);
  });

  it('escapes quotes in accessible names', () => {
    expect(buildSelectors({ role: 'button', name: 'Say "hi"' })).toEqual([
      'role=button[name="Say \\"hi\\""]',
    ]);
  });

  it('uses the visible text for elements without a role, before the css path', () => {
    expect(buildSelectors({ text: 'Apply promo', css: 'div > span' })).toEqual([
      'text="Apply promo"',
      'div > span',
    ]);
  });

  it('skips ids that look generated and removes duplicates', () => {
    expect(buildSelectors({ id: 'a3f9c2d10b7e', css: '#x', nameAttr: 'email' })).toEqual([
      '[name="email"]',
      '#x',
    ]);
    expect(buildSelectors({ id: 'x', css: '#x' })).toEqual(['#x']);
  });
});

describe('WorkflowRecorder', () => {
  const finalScreen: ScreenContent = {
    type: 'dom',
    raw: '<body>done</body>',
    normalized: '<body>done</body>',
    capturedAt: 0,
  };

  function record() {
    const recorder = new WorkflowRecorder('Create customer');
    const typed = recorder.addStep({
      actionType: 'type',
      selectors: ['#email'],
      value: 'ada@example.com',
    });
    recorder.addStep({ actionType: 'click', selectors: ['role=button[name="Save"]'] });
    recorder.markVariable(typed, { name: 'email', description: 'Customer e-mail' });
    return recorder;
  }

  it('turns a marked step into a variable and keeps its value as an observed payload', () => {
    const workflow = record().finish(finalScreen);

    expect(workflow.steps[0].variable).toBe('email');
    expect(workflow.variables).toEqual([{ name: 'email', description: 'Customer e-mail' }]);
    expect(workflow.observedPayloads).toEqual([{ email: 'ada@example.com' }]);
    expect(workflow.finalScreenId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('feeds schema inference with the recorded variable', () => {
    const workflow = record().finish();
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'CRM',
      startUrl: 'http://localhost/',
      workflows: [workflow],
    };

    const inferred = new SchemaInferencer().inferWorkflows(set).workflows[0].inputSchema as any;
    expect(inferred.properties.email).toMatchObject({ type: 'string', format: 'email' });
    expect(inferred.required).toEqual(['email']);
  });

  it('coerces typed values to the variable type', () => {
    const recorder = new WorkflowRecorder('Set quantity');
    const index = recorder.addStep({ actionType: 'type', selectors: ['#qty'], value: '3' });
    recorder.markVariable(index, { name: 'qty', type: 'number' });

    expect(recorder.finish().observedPayloads).toEqual([{ qty: 3 }]);
  });

  it('rejects invalid markings and empty workflows', () => {
    const recorder = new WorkflowRecorder('x');
    const click = recorder.addStep({ actionType: 'click', selectors: ['#a'] });

    expect(() => recorder.markVariable(5, { name: 'a' })).toThrow(/No step/);
    expect(() => recorder.markVariable(click, { name: 'a' })).toThrow(/no value/);

    const typed = recorder.addStep({ actionType: 'type', selectors: ['#b'], value: 'v' });
    recorder.markVariable(typed, { name: 'b' });
    expect(() => recorder.markVariable(typed, { name: 'c' })).toThrow(/already the variable/);
    expect(() => new WorkflowRecorder('empty').finish()).toThrow(/without steps/);
  });
});

describe('Workflow set persistence', () => {
  function makeSet(id: string, label: string, targetName = 'CRM'): WorkflowSet {
    return {
      version: '1',
      targetType: 'web',
      targetName,
      startUrl: 'http://localhost/',
      workflows: [
        {
          id,
          label,
          steps: [{ actionType: 'click', selectors: ['#go'] }],
          variables: [],
          observedPayloads: [],
        },
      ],
    };
  }

  const idA = '33333333-3333-4333-8333-333333333333';
  const idB = '44444444-4444-4444-8444-444444444444';

  it('round-trips through JSON with 2-space indentation', () => {
    const set = makeSet(idA, 'Go');
    const json = serializeWorkflowSet(set);

    expect(json).toContain('\n  "version": "1"');
    expect(deserializeWorkflowSet(json)).toEqual(set);
  });

  it('reports the invalid field when the document is malformed', () => {
    const bad = JSON.stringify({ ...makeSet(idA, 'Go'), version: '2' });

    expect(() => deserializeWorkflowSet(bad)).toThrow(DescriptiveParseError);
    try {
      deserializeWorkflowSet(bad);
    } catch (err) {
      expect((err as DescriptiveParseError).instancePath).toBe('/version');
    }
    expect(() => deserializeWorkflowSet('{')).toThrow(/Invalid JSON/);
  });

  it('merges by id, letting the newer set win, without mutating inputs', () => {
    const base = makeSet(idA, 'Old label');
    const newer = makeSet(idA, 'New label', 'CRM v2');
    newer.workflows.push(makeSet(idB, 'Other').workflows[0]);

    const merged = mergeWorkflowSets(base, newer);

    expect(merged.workflows.map((w) => [w.id, w.label])).toEqual([
      [idA, 'New label'],
      [idB, 'Other'],
    ]);
    expect(merged.targetName).toBe('CRM v2');
    expect(base.workflows[0].label).toBe('Old label');
  });
});
