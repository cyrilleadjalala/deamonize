// Feature: user-journey-improvements, Property 16: Radio group validity
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Page } from 'playwright';
import { LiveRecorder, type RadioInfo } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';
import { validateRadioGroup } from '../../src/recorder/variable-settings.js';

const stubPage = {} as unknown as Page;

const nameArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('Free', 'Pro', 'Team', 'Gold', 'Basic', 'Plus', 'Max') },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constantFrom(200, 201, 260).map((n) => 'n'.repeat(n)) },
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 12 }) },
);

const infoArb: fc.Arbitrary<RadioInfo> = fc
  .tuple(
    fc.array(nameArb, { minLength: 0, maxLength: 8 }),
    fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 40, max: 60 })),
    fc.boolean(),
    fc.nat(10),
  )
  .map(([names, extra, clickedDisabled, pick]) => {
    const clicked = names.length > 0 && pick < names.length ? names[pick] : pick % 2 === 0 ? 'Elsewhere' : '';
    return { names, total: names.length + extra, clicked, clickedDisabled };
  });

/** Requirements 8.3 to 8.6 written out from the text. */
function valid(info: RadioInfo): boolean {
  if (info.clickedDisabled || info.total < 2 || info.total > 50 || info.names.length > 50) return false;
  if (info.names.some((name) => name === '' || name.length > 200)) return false;
  if (new Set(info.names).size !== info.names.length) return false;
  return info.clicked !== '' && info.names.includes(info.clicked);
}

describe('Property 16: Radio group validity', () => {
  /** **Validates: Requirements 8.3, 8.4, 8.5, 8.6, 8.14** */
  it('accepts a group exactly when it has 2 to 50 radios with distinct names of 1 to 200 characters and an enabled click', () => {
    fc.assert(
      fc.property(infoArb, (info) => {
        const result = validateRadioGroup(info);
        expect(result.ok).toBe(valid(info));
        if (result.ok) {
          expect(result.enum).toEqual(info.names);
          expect(result.value).toBe(info.clicked);
        } else {
          expect(result.error).toMatch(/^[A-Z]/);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('through the Live_Recorder, a valid group makes an enum Variable and a refused one keeps the click as recorded', () => {
    fc.assert(
      fc.property(infoArb, (info) => {
        const recorder = new WorkflowRecorder('Property');
        const live = new LiveRecorder(stubPage, recorder);
        live.handle({ actionType: 'click', info: { role: 'radio', name: info.clicked || 'x', css: '#r' }, label: 'click radio', radio: info });
        const answer = live.handleMarkVariable({ stepIndex: 0, name: 'choice', type: 'string' });
        expect(answer.ok).toBe(valid(info));
        const step = recorder.stepsSoFar()[0];
        if (answer.ok) {
          expect(recorder.variableList()).toEqual([{ name: 'choice', type: 'string', enum: info.names }]);
          expect(step).toMatchObject({ actionType: 'click', value: info.clicked, variable: 'choice' });
          expect(recorder.finish().observedPayloads).toEqual([{ choice: info.clicked }]);
        } else {
          expect(recorder.variableList()).toEqual([]);
          expect(step.actionType).toBe('click');
          expect(step.value).toBeUndefined();
          expect(step.variable).toBeUndefined();
        }
      }),
      { numRuns: 200 },
    );
  });
});
