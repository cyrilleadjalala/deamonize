// Feature: user-journey-improvements, Property 17: File fields are counted, not recorded
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Page } from 'playwright';
import { LiveRecorder } from '../../src/recorder/live-recorder.js';
import { WorkflowRecorder } from '../../src/recorder/workflow-recorder.js';

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

const signalArb = fc.record({
  frame: fc.integer({ min: 0, max: 3 }),
  fieldId: fc.oneof(fc.constantFrom('file-a', 'file-b', 'file-c', 'file-d'), fc.string({ minLength: 1, maxLength: 6 })),
});

describe('Property 17: File fields are counted, not recorded', () => {
  /** **Validates: Requirements 9.5, 9.6** */
  it('counts each (frame, field) pair once and records no step, no Variable and no field', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(signalArb, { minLength: 0, maxLength: 40 }), async (signals) => {
        const fake = fakePage();
        const recorder = new WorkflowRecorder('Property');
        const live = new LiveRecorder(fake.page, recorder);
        await live.attach();
        const frames = [0, 1, 2, 3].map(() => ({ page: () => fake.page, parentFrame: () => null }));
        const panel = fake.bindings.get('__daemonizePanel')!;

        const distinct = new Set<string>();
        for (const signal of signals) {
          const answer = await panel({ frame: frames[signal.frame] }, { type: 'file', fieldId: signal.fieldId });
          expect(answer).toEqual({ ok: true });
          distinct.add(`${signal.frame}|${signal.fieldId}`);
        }
        expect(live.unrecordedFileFields).toBe(distinct.size);
        expect(live.panelSummary().files).toBe(distinct.size);
        expect(live.stepCount).toBe(0);
        expect(recorder.stepsSoFar()).toEqual([]);
        expect(recorder.variableList()).toEqual([]);
        expect(live.panelFields()).toEqual({ fields: [] });
      }),
      { numRuns: 100 },
    );
  });

  it('does not count a signal without a usable field id', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.constant(undefined), fc.constant(null), fc.integer(), fc.constant(''), fc.constant({}), fc.string({ minLength: 101, maxLength: 140 })), async (fieldId) => {
        const fake = fakePage();
        const live = new LiveRecorder(fake.page, new WorkflowRecorder('Property'));
        await live.attach();
        const answer = await fake.bindings.get('__daemonizePanel')!({ frame: fake.frame }, { type: 'file', fieldId });
        expect(answer).toEqual({ ok: false });
        expect(live.unrecordedFileFields).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
