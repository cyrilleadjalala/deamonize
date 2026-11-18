// Feature: user-journey-improvements, Property 10: Variable requests are validated before any change
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

const stubPage = {} as unknown as Page;

const valueArb = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom('42', ' 7 ', '1e3', '-0.5', 'true', 'false', 'TRUE', '', '   ', 'abc', 'NaN', 'Infinity', '0x10'),
);
const typeArb = fc.option(fc.oneof(fc.constantFrom('string', 'number', 'boolean'), fc.constantFrom('text', 'date', 'String', ''), fc.constantFrom(7, null, true)), { nil: undefined });
const optionalArb = fc.option(fc.oneof(fc.boolean(), fc.constantFrom('true', 1, null)), { nil: undefined });
const omittedArb = fc.option(fc.oneof(fc.constantFrom('skip', 'useRecorded'), fc.constantFrom('Skip', 'ignore', '', 3, null)), { nil: undefined });
const rowTextArb = fc.option(fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom(5, null)), { nil: undefined });

const TYPES = ['string', 'number', 'boolean'];
const OMITTED = ['skip', 'useRecorded'];

/** Requirements 5.4 to 5.7, written out again from the text, not from the code. */
function oracle(request: { type?: unknown; optional?: unknown; whenOmitted?: unknown; rowText?: unknown }, value: string): boolean {
  const { type, optional, whenOmitted, rowText } = request;
  if (type !== undefined && !TYPES.includes(type as string)) return false;
  if (optional !== undefined && typeof optional !== 'boolean') return false;
  if (whenOmitted !== undefined && !OMITTED.includes(whenOmitted as string)) return false;
  if (whenOmitted !== undefined && optional !== true) return false;
  if (rowText !== undefined) return typeof rowText === 'string' && (type === undefined || type === 'string');
  if (type === 'number') return value.trim() !== '' && Number.isFinite(Number(value.trim()));
  if (type === 'boolean') return value === 'true' || value === 'false';
  return true;
}

function snapshot(recorder: WorkflowRecorder): string {
  const workflow = recorder.finish();
  return JSON.stringify([workflow.variables, workflow.steps, workflow.observedPayloads]);
}

describe('Property 10: Variable requests are validated before any change', () => {
  /** **Validates: Requirements 5.4, 5.5, 5.6, 5.7, 5.8, 5.10, 6.10, 6.11, 6.15, 7.3** */
  it('accepts exactly the valid requests, changes nothing for the others, and stores what was asked', () => {
    fc.assert(
      fc.property(valueArb, typeArb, optionalArb, omittedArb, rowTextArb, (value, type, optional, whenOmitted, rowText) => {
        const recorder = new WorkflowRecorder('Property');
        const live = new LiveRecorder(stubPage, recorder);
        live.handle({ actionType: 'type', info: { role: 'textbox', name: 'Field', css: '#f' }, value, label: 'type Field' });
        const request: Record<string, unknown> = { stepIndex: rowText === undefined ? 0 : -1, name: 'chosen' };
        for (const [key, entry] of Object.entries({ type, optional, whenOmitted, rowText })) if (entry !== undefined) request[key] = entry;

        const before = snapshot(recorder);
        const answer = live.handleMarkVariable(request as never);
        const valid = oracle(request, value);
        expect(answer.ok).toBe(valid);

        if (!answer.ok) {
          expect(answer.error.length).toBeGreaterThan(0);
          expect(snapshot(recorder)).toBe(before);
          expect(recorder.variableList()).toEqual([]);
          return;
        }
        const variable = recorder.variableList()[0];
        expect(variable.name).toBe('chosen');
        // Only what the request carried is written (5.8): no setting means no field
        expect(variable.type).toBe(type);
        expect(variable.optional).toBe(optional === true ? true : undefined);
        expect(variable.whenOmitted).toBe(optional === true ? whenOmitted : undefined);
        if (rowText === undefined) {
          const stored = recorder.finish().observedPayloads[0].chosen;
          expect(stored).toBe(type === 'number' ? Number(value.trim()) : type === 'boolean' ? value === 'true' : value);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('answers a request that follows a refused one exactly as if the refused one never came', () => {
    fc.assert(
      fc.property(valueArb, typeArb, optionalArb, omittedArb, (value, type, optional, whenOmitted) => {
        const run = (withNoise: boolean): string => {
          const recorder = new WorkflowRecorder('Property');
          const live = new LiveRecorder(stubPage, recorder);
          live.handle({ actionType: 'type', info: { role: 'textbox', name: 'Field', css: '#f' }, value, label: 'type Field' });
          const request: Record<string, unknown> = { stepIndex: 0, name: 'chosen' };
          for (const [key, entry] of Object.entries({ type, optional, whenOmitted })) if (entry !== undefined) request[key] = entry;
          if (withNoise) live.handleMarkVariable({ stepIndex: 0, name: 'noise', type: 'date' } as never);
          live.handleMarkVariable(request as never);
          return snapshot(recorder);
        };
        expect(run(true)).toBe(run(false));
      }),
      { numRuns: 100 },
    );
  });
});
