// Feature: user-journey-improvements, Property 12: The fields answer reveals no value
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Page } from 'playwright';
import { LiveRecorder, type CapturedEvent } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

const stubPage = {} as unknown as Page;

type Kind = 'type' | 'secret' | 'select' | 'check' | 'radio' | 'click' | 'keypress';
const kindArb = fc.constantFrom<Kind>('type', 'secret', 'select', 'check', 'radio', 'click', 'keypress');

/** Every value is a marker that no label or message can contain by chance. */
function eventFor(kind: Kind, index: number): CapturedEvent {
  const marker = `VALUE-${index}-zq`;
  const info = { role: 'textbox', name: `Field ${index}`, css: `#f${index}` };
  switch (kind) {
    case 'type': return { actionType: 'type', info, value: marker, label: `type Field ${index}` };
    case 'secret': return { actionType: 'type', info, label: `type Field ${index}`, secretRef: index % 2 === 0 ? 'PASSWORD' : 'OTP' };
    case 'select': return { actionType: 'select', info: { ...info, role: 'combobox' }, value: marker, label: `select Field ${index}` };
    case 'check': return { actionType: 'check', info: { ...info, role: 'checkbox' }, value: 'true', label: `check Field ${index}` };
    case 'radio': return { actionType: 'click', info: { ...info, role: 'radio' }, label: `click Field ${index}`, radio: { names: ['A', 'B'], total: 2, clicked: 'A', clickedDisabled: false } };
    case 'click': return { actionType: 'click', info: { ...info, role: 'button' }, label: `click Field ${index}` };
    default: return { actionType: 'keypress', info, value: 'Enter', label: `keypress Field ${index}` };
  }
}

const eligible = (kind: Kind): boolean => kind === 'type' || kind === 'select' || kind === 'check' || kind === 'radio';

describe('Property 12: The fields answer reveals no value', () => {
  /** **Validates: Requirements 6.3, 6.4, 6.5, 6.6** */
  it('lists only non-secret fields, at most the last 100 by step index, with no recorded value', () => {
    fc.assert(
      fc.property(fc.array(kindArb, { minLength: 0, maxLength: 260 }), (kinds) => {
        const recorder = new WorkflowRecorder('Property');
        const live = new LiveRecorder(stubPage, recorder);
        const indexOf: number[] = [];
        kinds.forEach((kind, i) => {
          const index = live.handle(eventFor(kind, i));
          if (index !== null) indexOf[i] = index;
        });
        const expected = kinds.flatMap((kind, i) => (eligible(kind) ? [indexOf[i]] : [])).slice(-100);
        const answer = live.panelFields();

        expect(answer.fields.map((f) => f.stepIndex)).toEqual(expected);
        expect(answer.fields.length).toBeLessThanOrEqual(100);
        const steps = recorder.stepsSoFar();
        for (const field of answer.fields) {
          expect(Number.isInteger(field.stepIndex) && field.stepIndex >= 0).toBe(true);
          expect(field.label.length).toBeLessThanOrEqual(200);
          expect(['text', 'choice', 'check', 'radio']).toContain(field.kind);
          expect(steps[field.stepIndex].secretRef).toBeUndefined();
          expect(field.variable).toBeUndefined();
        }
        const text = JSON.stringify(answer);
        expect(text).not.toMatch(/VALUE-\d+-zq/);
        expect(Object.keys(answer)).toEqual(['fields']);
      }),
      { numRuns: 100 },
    );
  });

  it('adds the Variable of a field with its settings, and still no value', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.constantFrom('skip', 'useRecorded'), fc.constantFrom('string', 'boolean'), (optional, whenOmitted, type) => {
        const recorder = new WorkflowRecorder('Property');
        const live = new LiveRecorder(stubPage, recorder);
        live.handle(type === 'boolean' ? eventFor('check', 0) : eventFor('type', 0));
        const request = optional ? { stepIndex: 0, name: 'chosen', type, optional: true, whenOmitted } : { stepIndex: 0, name: 'chosen', type };
        expect(live.handleMarkVariable(request as never)).toEqual({ ok: true });
        const [field] = live.panelFields().fields;
        expect(field.variable).toEqual(optional ? { name: 'chosen', type, optional: true, whenOmitted } : { name: 'chosen', type, optional: false });
        expect(JSON.stringify(live.panelFields())).not.toMatch(/VALUE-\d+-zq/);
      }),
      { numRuns: 100 },
    );
  });
});
