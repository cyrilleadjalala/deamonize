import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright';
import { LiveRecorder, type CapturedEvent, type RadioInfo } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

const stubPage = {} as unknown as Page;

function typed(name: string, value: string): CapturedEvent {
  return { actionType: 'type', info: { role: 'textbox', name, css: `#${name}` }, value, label: `type ${name}` };
}
const checkbox = (name: string, value: 'true' | 'false'): CapturedEvent => ({
  actionType: 'check', info: { role: 'checkbox', name, css: `#${name}` }, value, label: `check ${name}`,
});
const radio = (clicked: string, info: Partial<RadioInfo> = {}): CapturedEvent => ({
  actionType: 'click',
  info: { role: 'radio', name: clicked, css: `#${clicked}` },
  label: `click ${clicked}`,
  radio: { names: ['Free', 'Pro', 'Team'], total: 3, clicked, clickedDisabled: false, ...info },
});

/** A fake page that keeps the bindings the recorder exposes, to call them like the page does. */
function fakePage() {
  const bindings = new Map<string, (source: unknown, arg?: unknown) => unknown>();
  const frame = { page: () => page, parentFrame: () => null };
  const page = {
    exposeBinding: async (name: string, fn: (source: unknown, arg?: unknown) => unknown) => { bindings.set(name, fn); },
    addInitScript: async () => { },
    evaluate: async () => { },
    frames: () => [],
    url: () => 'http://example.test/',
    on: () => { },
    mainFrame: () => frame,
    context: () => ({}),
  };
  return { page: page as unknown as Page, bindings, frame };
}

function setup(): { live: LiveRecorder; recorder: WorkflowRecorder } {
  const recorder = new WorkflowRecorder('Requests');
  return { live: new LiveRecorder(stubPage, recorder), recorder };
}

describe('Live_Recorder "Make variable" requests (5.4 to 5.7)', () => {
  it('stores a valid type, optional and whenOmitted, and coerces the observed payload', () => {
    const { live, recorder } = setup();
    live.handle(typed('Age', ' 42 '));
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'age', type: 'number', optional: true, whenOmitted: 'skip' })).toEqual({ ok: true });
    const workflow = recorder.finish();
    expect(workflow.variables).toEqual([{ name: 'age', description: 'Age', type: 'number', optional: true, whenOmitted: 'skip' }]);
    expect(workflow.observedPayloads).toEqual([{ age: 42 }]);
  });

  it.each([
    [{ type: 'date' }],
    [{ type: 5 }],
    [{ type: null }],
    [{ optional: 'yes' }],
    [{ optional: 1 }],
    [{ optional: true, whenOmitted: 'ignore' }],
    [{ optional: true, whenOmitted: 1 }],
  ])('refuses %j and changes nothing', (extra) => {
    const { live, recorder } = setup();
    live.handle(typed('Age', '42'));
    const result = live.handleMarkVariable({ stepIndex: 0, name: 'age', ...extra } as never);
    expect(result).toMatchObject({ ok: false });
    expect(recorder.variableList()).toEqual([]);
    expect(recorder.stepsSoFar()[0].variable).toBeUndefined();
    expect(recorder.variableValues().size).toBe(0);
  });

  it('refuses whenOmitted without optional: true (5.5)', () => {
    const { live, recorder } = setup();
    live.handle(typed('Age', '42'));
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'age', whenOmitted: 'skip' })).toMatchObject({ ok: false });
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'age', optional: false, whenOmitted: 'skip' })).toMatchObject({ ok: false });
    expect(recorder.variableList()).toEqual([]);
  });

  it('refuses a number or a true or false type for a value that is not one (5.6), in plain words', () => {
    const { live, recorder } = setup();
    live.handle(typed('Age', 'abc'));
    live.handle(typed('Blank', '  '));
    live.handle(typed('Flag', 'yes'));
    const number = live.handleMarkVariable({ stepIndex: 0, name: 'a', type: 'number' });
    const blank = live.handleMarkVariable({ stepIndex: 1, name: 'b', type: 'number' });
    const flag = live.handleMarkVariable({ stepIndex: 2, name: 'c', type: 'boolean' });
    for (const result of [number, blank, flag]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^[A-Z].*\.$/);
    }
    expect(recorder.variableList()).toEqual([]);
    live.handle(typed('Flag', 'true'));
    expect(live.handleMarkVariable({ stepIndex: 3, name: 'flag', type: 'boolean' })).toEqual({ ok: true });
    expect(recorder.finish().observedPayloads).toEqual([{ flag: true }]);
  });

  it('accepts only a text type with rowText (5.7)', () => {
    const { live, recorder } = setup();
    expect(live.handleMarkVariable({ stepIndex: -1, name: 'k', rowText: 'Ada', type: 'number' })).toMatchObject({ ok: false });
    expect(live.handleMarkVariable({ stepIndex: -1, name: 'k', rowText: 'Ada', type: 'boolean' })).toMatchObject({ ok: false });
    expect(live.handleMarkVariable({ stepIndex: -1, name: 'k', rowText: 7 as never })).toMatchObject({ ok: false });
    expect(recorder.variableList()).toEqual([]);
    expect(live.handleMarkVariable({ stepIndex: -1, name: 'k', rowText: 'Ada', type: 'string', optional: true })).toEqual({ ok: true });
    expect(recorder.variableList()).toEqual([{ name: 'k', description: 'text of a row', type: 'string', optional: true }]);
  });

  it('still refuses a bad name, an unknown step and a repeated name as before', () => {
    const { live } = setup();
    live.handle(typed('Age', '42'));
    expect(live.handleMarkVariable({ stepIndex: 0, name: '1 bad' })).toMatchObject({ ok: false, error: expect.stringContaining('letters, digits') });
    expect(live.handleMarkVariable({ stepIndex: 9, name: 'ok' })).toMatchObject({ ok: false });
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'ok' })).toEqual({ ok: true });
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'again' })).toMatchObject({ ok: false });
  });
});

describe('check and radio variables (7.3, 8.3, 8.5, 8.6)', () => {
  it('makes a check step a boolean Variable and refuses another type', () => {
    const { live, recorder } = setup();
    live.handle(checkbox('Newsletter', 'true'));
    expect(recorder.stepsSoFar()[0]).toMatchObject({ actionType: 'check', value: 'true', risk: 'read' });
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'n', type: 'string' })).toMatchObject({ ok: false });
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'n', type: 'number' })).toMatchObject({ ok: false });
    expect(recorder.variableList()).toEqual([]);
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'n', type: 'boolean' })).toEqual({ ok: true });
    expect(recorder.variableList()[0]).toMatchObject({ name: 'n', type: 'boolean' });
    expect(recorder.finish().observedPayloads).toEqual([{ n: true }]);
  });

  it('normalises an unexpected check value to "false"', () => {
    const { live, recorder } = setup();
    live.handle({ ...checkbox('A', 'true'), value: 'mixed' });
    expect(recorder.stepsSoFar()[0].value).toBe('false');
  });

  it('makes a radio click an enum Variable with the clicked name as the recorded value', () => {
    const { live, recorder } = setup();
    live.handle(radio('Pro'));
    expect(recorder.stepsSoFar()[0].value).toBeUndefined();
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'plan', type: 'string', optional: true, whenOmitted: 'useRecorded' })).toEqual({ ok: true });
    const workflow = recorder.finish();
    expect(workflow.variables).toEqual([{ name: 'plan', type: 'string', optional: true, whenOmitted: 'useRecorded', enum: ['Free', 'Pro', 'Team'] }]);
    expect(workflow.steps[0]).toMatchObject({ value: 'Pro', variable: 'plan' });
    expect(workflow.observedPayloads).toEqual([{ plan: 'Pro' }]);
  });

  it('refuses a radio Variable of another type', () => {
    const { live, recorder } = setup();
    live.handle(radio('Pro'));
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'plan', type: 'number' })).toMatchObject({ ok: false });
    expect(recorder.variableList()).toEqual([]);
  });

  it.each([
    ['more than 50 radios', { total: 51 }],
    ['an empty name', { names: ['Free', '', 'Team'] }],
    ['a name over 200 characters', { names: ['Free', 'x'.repeat(201), 'Team'] }],
    ['a repeated name', { names: ['Free', 'Pro', 'Pro'] }],
    ['a disabled clicked radio', { clickedDisabled: true }],
    ['a group of one', { names: ['Pro'], total: 1 }],
  ])('refuses %s, creates no Variable and keeps the click as recorded', (_why, info) => {
    const { live, recorder } = setup();
    live.handle(radio('Pro', info as Partial<RadioInfo>));
    const answer = live.handleMarkVariable({ stepIndex: 0, name: 'plan', type: 'string' });
    expect(answer.ok).toBe(false);
    expect(recorder.variableList()).toEqual([]);
    expect(recorder.stepsSoFar()[0]).toMatchObject({ actionType: 'click' });
    expect(recorder.stepsSoFar()[0].value).toBeUndefined();
    expect(recorder.stepsSoFar()[0].variable).toBeUndefined();
  });

  it('accepts a name of exactly 200 characters and a group of exactly 50 radios', () => {
    const { live } = setup();
    const long = 'y'.repeat(200);
    const names = Array.from({ length: 50 }, (_, i) => `R${i}`);
    names[0] = long;
    live.handle(radio(long, { names, total: 50 }));
    expect(live.handleMarkVariable({ stepIndex: 0, name: 'big', type: 'string' })).toEqual({ ok: true });
  });
});

describe('edit of a Variable (6.10, 6.11)', () => {
  function withTwo() {
    const { live, recorder } = setup();
    live.handle(typed('Age', '42'));
    live.handle(typed('City', 'Paris'));
    live.handleMarkVariable({ stepIndex: 0, name: 'age' });
    live.handleMarkVariable({ stepIndex: 1, name: 'city' });
    return { live, recorder };
  }

  it('renames, retypes and sets optional in one step', () => {
    const { live, recorder } = withTwo();
    expect(live.handleEditVariable({ name: 'age', newName: 'years', type: 'number', optional: true, whenOmitted: 'skip' })).toEqual({ ok: true });
    const workflow = recorder.finish();
    expect(workflow.variables[0]).toEqual({ name: 'years', description: 'Age', type: 'number', optional: true, whenOmitted: 'skip' });
    expect(workflow.steps[0].variable).toBe('years');
    expect(workflow.observedPayloads).toEqual([{ years: 42, city: 'Paris' }]);
  });

  it('turns optional off by removing optional and whenOmitted', () => {
    const { live, recorder } = withTwo();
    live.handleEditVariable({ name: 'age', optional: true, whenOmitted: 'skip' });
    expect(live.handleEditVariable({ name: 'age', optional: false })).toEqual({ ok: true });
    expect(recorder.variableList()[0]).toEqual({ name: 'age', description: 'Age' });
  });

  it.each([
    ['an unknown name', { name: 'nope', newName: 'x' }],
    ['a name used by another Variable', { name: 'age', newName: 'city' }],
    ['a name that does not match the pattern', { name: 'age', newName: '1x' }],
    ['a name with a space', { name: 'age', newName: 'a b' }],
    ['a name of 65 characters', { name: 'age', newName: 'a'.repeat(65) }],
    ['whenOmitted without optional', { name: 'age', whenOmitted: 'skip' }],
    ['a type that is not one', { name: 'age', type: 'date' }],
    ['a value that is not a number', { name: 'city', type: 'number' }],
    ['a value that is not true or false', { name: 'age', type: 'boolean' }],
  ])('refuses %s and leaves everything unchanged', (_why, request) => {
    const { live, recorder } = withTwo();
    const before = JSON.stringify([recorder.variableList(), recorder.stepsSoFar(), recorder.finish().observedPayloads]);
    expect(live.handleEditVariable(request as never)).toMatchObject({ ok: false });
    expect(JSON.stringify([recorder.variableList(), recorder.stepsSoFar(), recorder.finish().observedPayloads])).toBe(before);
  });

  it('accepts a new name of exactly 64 characters', () => {
    const { live, recorder } = withTwo();
    const name = 'a'.repeat(64);
    expect(live.handleEditVariable({ name: 'age', newName: name })).toEqual({ ok: true });
    expect(recorder.variableList()[0].name).toBe(name);
  });

  it('keeps a checkbox Variable boolean', () => {
    const { live, recorder } = setup();
    live.handle(checkbox('Newsletter', 'true'));
    live.handleMarkVariable({ stepIndex: 0, name: 'n' });
    expect(live.handleEditVariable({ name: 'n', type: 'string' })).toMatchObject({ ok: false });
    expect(recorder.variableList()[0].type).toBe('boolean');
  });
});

describe('the fields answer (6.3 to 6.6)', () => {
  it('lists typed, selected, checked and radio steps with a label and no value, and the Variable of each', () => {
    const { live } = setup();
    live.handle(typed('Email', 'ada@example.com'));
    live.handle({ actionType: 'select', info: { role: 'combobox', name: 'City', css: '#c' }, value: 'Paris', label: 'select City' });
    live.handle(checkbox('Newsletter', 'true'));
    live.handle(radio('Pro'));
    live.handle({ actionType: 'click', info: { role: 'button', name: 'Save', css: '#s' }, label: 'click Save' });
    live.handleMarkVariable({ stepIndex: 0, name: 'email', optional: true, whenOmitted: 'skip' });
    const answer = live.panelFields();
    expect(answer.fields.map((f) => [f.stepIndex, f.kind])).toEqual([[0, 'text'], [1, 'choice'], [2, 'check'], [3, 'radio']]);
    expect(answer.fields[0].variable).toEqual({ name: 'email', type: 'string', optional: true, whenOmitted: 'skip' });
    expect(answer.fields[1].variable).toBeUndefined();
    const text = JSON.stringify(answer);
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('Paris');
  });

  it('leaves out secret steps', () => {
    const { live } = setup();
    live.handle({ actionType: 'type', info: { role: 'textbox', name: 'Code', css: '#code' }, label: 'type Code', secretRef: 'OTP' });
    live.handle({ actionType: 'type', info: { role: 'textbox', name: 'Pass', css: '#pw' }, label: 'type Pass', secretRef: 'PASSWORD' });
    expect(live.panelFields()).toEqual({ fields: [] });
  });

  it('answers the 100 most recent fields, in ascending order', () => {
    const { live } = setup();
    for (let i = 0; i < 130; i++) live.handle(typed(`F${i}`, `v${i}`));
    const { fields } = live.panelFields();
    expect(fields).toHaveLength(100);
    expect(fields[0].stepIndex).toBe(30);
    expect(fields[99].stepIndex).toBe(129);
    expect(fields.map((f) => f.stepIndex)).toEqual([...fields.map((f) => f.stepIndex)].sort((a, b) => a - b));
  });

  it('never repeats the recorded value in a label', () => {
    const { live } = setup();
    live.handle({ ...typed('Name', 'Name'), label: 'type Name' });
    const [field] = live.panelFields().fields;
    expect(field.label).not.toContain('Name');
    expect(field.label.length).toBeLessThanOrEqual(200);
  });
});

describe('the panel binding: file signal and finish scope (9.5, 9.6, 19.5, 19.6)', () => {
  async function attached() {
    const fake = fakePage();
    const recorder = new WorkflowRecorder('Binding');
    const live = new LiveRecorder(fake.page, recorder, { kiroHomeExists: true });
    await live.attach();
    const panel = (request: unknown, frame: unknown = fake.frame) => fake.bindings.get('__daemonizePanel')!({ frame }, request);
    const finish = (request: unknown) => fake.bindings.get('__daemonizeFinish')!({ frame: fake.frame }, request);
    return { live, recorder, panel, finish };
  }

  it('counts each file field once and records no step, no Variable and no field', async () => {
    const { live, recorder, panel } = await attached();
    await panel({ type: 'file', fieldId: 'file-a-1' });
    await panel({ type: 'file', fieldId: 'file-a-1' });
    await panel({ type: 'file', fieldId: 'file-b-2' });
    expect(live.unrecordedFileFields).toBe(2);
    expect(live.panelSummary().files).toBe(2);
    expect(live.stepCount).toBe(0);
    expect(recorder.variableList()).toEqual([]);
    expect(live.panelFields()).toEqual({ fields: [] });
  });

  it('counts the same id in two frames as two fields, and ignores an id that is not text', async () => {
    const { live, panel } = await attached();
    await panel({ type: 'file', fieldId: 'x' });
    await panel({ type: 'file', fieldId: 'x' }, { page: () => null });
    expect(await panel({ type: 'file', fieldId: 42 })).toEqual({ ok: false });
    expect(await panel({ type: 'file' })).toEqual({ ok: false });
    expect(live.unrecordedFileFields).toBe(2);
  });

  it('keeps the scope only for kiro and only as global or project', async () => {
    const a = await attached();
    await a.finish({ intent: 'kiro', scope: 'global' });
    expect(a.live.finishIntent).toBe('kiro');
    expect(a.live.finishScope).toBe('global');

    const b = await attached();
    await b.finish({ intent: 'kiro', scope: 'project' });
    expect(b.live.finishScope).toBe('project');

    for (const scope of [undefined, null, 1, 'Global', 'all', '', {}]) {
      const c = await attached();
      await c.finish({ intent: 'kiro', scope });
      expect(c.live.finishIntent).toBe('kiro');
      expect(c.live.finishScope).toBeUndefined();
    }
    for (const intent of ['save', 'test']) {
      const d = await attached();
      await d.finish({ intent, scope: 'global' });
      expect(d.live.finishIntent).toBe(intent);
      expect(d.live.finishScope).toBeUndefined();
    }
  });

  it('ignores a second finish request', async () => {
    const { live, finish } = await attached();
    await finish({ intent: 'kiro', scope: 'project' });
    await finish({ intent: 'save' });
    expect(live.finishIntent).toBe('kiro');
    expect(live.finishScope).toBe('project');
  });

  it('answers the state with kiroHomeExists from the options', async () => {
    const { panel } = await attached();
    expect(await panel({ type: 'state' })).toMatchObject({ kiroHomeExists: true });
  });
});
