import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { LiveRecorder, type CapturedEvent } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { serializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { Workflow, WorkflowSet } from '../../src/types.js';

/** A page with no browser behind it: `handle` and the variable requests only need the recorder. */
const stubPage = {} as unknown as Page;

const nameField: CapturedEvent = {
  actionType: 'type',
  info: { role: 'textbox', name: 'Customer name', css: '#name' },
  value: 'Ada',
  label: 'type Customer name',
};
const saveButton: CapturedEvent = { actionType: 'click', info: { role: 'button', name: 'Save', css: '#save' }, label: 'click Save' };

function fileOf(workflow: Workflow): string {
  const set: WorkflowSet = {
    version: '1',
    targetType: 'web',
    targetName: 'app',
    startUrl: 'https://example.test/',
    workflows: [{ ...workflow, id: '00000000-0000-4000-8000-000000000001' }],
  } as unknown as WorkflowSet;
  return serializeWorkflowSet(set);
}

describe('recorder compatibility (a recording that uses none of the new controls)', () => {
  it('builds the same Variable and writes the same file content as before for a request without the new settings', () => {
    // The way the page made a Variable before this change: the field description, nothing else
    const before = new WorkflowRecorder('Create');
    const oldLive = new LiveRecorder(stubPage, before);
    oldLive.handle(nameField);
    oldLive.handle(saveButton);
    oldLive.markVariable(0, { name: 'customer_name', description: 'Customer name' });

    const after = new WorkflowRecorder('Create');
    const live = new LiveRecorder(stubPage, after);
    live.handle(nameField);
    live.handle(saveButton);
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'customer_name' })).toEqual({ ok: true });

    const oldFlow = before.finish();
    const newFlow = after.finish();
    expect(newFlow.variables).toEqual([{ name: 'customer_name', description: 'Customer name' }]);
    expect(newFlow.variables).toEqual(oldFlow.variables);
    expect(fileOf(newFlow)).toBe(fileOf(oldFlow));
  });

  it('writes a row-text Variable as before when the request has no settings', () => {
    const recorder = new WorkflowRecorder('Row');
    const live = new LiveRecorder(stubPage, recorder);
    live.handle(saveButton);
    expect(live.handleMarkVariable({ stepIndex: -1, name: 'row_key', rowText: 'Ada' })).toEqual({ ok: true });
    expect(recorder.finish().variables).toEqual([{ name: 'row_key', description: 'text of a row' }]);
  });

  it('writes no optional and no whenOmitted when the new controls are not used', () => {
    const recorder = new WorkflowRecorder('Plain');
    const live = new LiveRecorder(stubPage, recorder);
    live.handle(nameField);
    live.handle(saveButton);
    live.handleMarkVariable({ stepIndex: 0, name: 'who' });
    const text = fileOf(recorder.finish());
    expect(text).not.toContain('optional');
    expect(text).not.toContain('whenOmitted');
    expect(text).not.toContain('"check"');
  });

  it('keeps a click on a plain button a click', () => {
    const recorder = new WorkflowRecorder('Click');
    const live = new LiveRecorder(stubPage, recorder);
    expect(live.handle(saveButton)).toBe(0);
    expect(recorder.stepsSoFar()[0]).toMatchObject({ actionType: 'click', risk: 'write' });
    expect(recorder.stepsSoFar()[0].value).toBeUndefined();
  });

  it('keeps the panel answers it had, with the new fields at their neutral values', () => {
    const live = new LiveRecorder(stubPage, new WorkflowRecorder('Panel'));
    expect(live.panelSummary()).toEqual({ steps: 0, variables: [], secrets: 0, files: 0 });
    expect(live.panelState()).toMatchObject({ steps: 0, studio: false, kiroHomeExists: false });
    expect(live.finishScope).toBeUndefined();
    expect(live.unrecordedFileFields).toBe(0);
  });
});
