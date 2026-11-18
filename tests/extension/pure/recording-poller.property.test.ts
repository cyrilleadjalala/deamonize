// Feature: kiro-thin-extension, Property 15: The recording poller has one loop and stops at the right moment
// **Validates: Requirements 11.8, 11.14, 11.15**
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createRecordingPoller } from '../../../kiro-extension/src/core/recording-poller';
import type { ApiResult, RecordingState, RecordingStatus } from '../../../kiro-extension/src/core/types';

type Step = RecordingState | 'fail' | 'throw';
const step: fc.Arbitrary<Step> = fc.constantFrom<Step>('recording', 'recording', 'recording', 'saving', 'compiling', 'fail', 'throw', 'done', 'error', 'idle');
const ACTIVE = new Set<Step>(['recording', 'saving', 'compiling']);

/** The expected outcome of a script, computed independently of the poller. */
function simulate(script: Step[]): { fetches: number; end: 'finished' | 'gave-up'; statuses: number } {
  let failures = 0;
  let statuses = 0;
  for (let i = 0; ; i++) {
    const s = script[i] ?? 'done';
    if (s === 'fail' || s === 'throw') {
      failures += 1;
      if (failures >= 3) return { fetches: i + 1, end: 'gave-up', statuses };
      continue;
    }
    failures = 0;
    statuses += 1;
    if (!ACTIVE.has(s)) return { fetches: i + 1, end: 'finished', statuses };
  }
}

describe('Property 15: recording poller', () => {
  it('runs one loop, stops at the first non-active state and gives up after three failures in a row', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 15 }), fc.integer({ min: 1, max: 4 }), async (script, extraStarts) => {
        const timers: Array<() => void> = [];
        let inFlight = 0;
        let maxInFlight = 0;
        let fetches = 0;
        const statuses: RecordingStatus[] = [];
        let finished: RecordingStatus | undefined;
        let gaveUp = 0;
        const poller = createRecordingPoller({
          fetchStatus: async (): Promise<ApiResult<RecordingStatus>> => {
            const s = script[fetches] ?? 'done';
            fetches += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            if (s === 'throw') throw new Error('network');
            if (s === 'fail') return { ok: false, status: 500, error: 'x' };
            return { ok: true, status: 200, data: { state: s, steps: fetches, labels: [] } };
          },
          onStatus: (st) => void statuses.push(st),
          onFinished: (st) => void (finished = st),
          onGaveUp: () => void (gaveUp += 1),
          setTimeout: ((fn: () => void) => (timers.push(fn), timers.length)) as unknown as typeof setTimeout,
          clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
        });
        poller.start();
        for (let i = 0; i < extraStarts; i++) poller.start();
        for (let guard = 0; guard < 100; guard++) {
          for (let k = 0; k < 5; k++) await Promise.resolve();
          const next = timers.shift();
          if (next === undefined) break;
          next();
        }
        for (let k = 0; k < 5; k++) await Promise.resolve();
        const expected = simulate(script);
        expect(maxInFlight).toBe(1);
        expect(fetches).toBe(expected.fetches);
        expect(statuses).toHaveLength(expected.statuses);
        expect(poller.running).toBe(false);
        if (expected.end === 'finished') {
          expect(finished).toBeDefined();
          expect(ACTIVE.has(finished!.state)).toBe(false);
          expect(gaveUp).toBe(0);
        } else {
          expect(gaveUp).toBe(1);
          expect(finished).toBeUndefined();
        }
      }),
      { numRuns: 200 }
    );
  });

  it('stop() ends the loop and ignores an answer that arrives later', async () => {
    const timers: Array<() => void> = [];
    let seen = 0;
    const poller = createRecordingPoller({
      fetchStatus: async () => ({ ok: true, status: 200, data: { state: 'recording', steps: 1, labels: [] } }),
      onStatus: () => void seen++,
      onFinished: () => undefined,
      onGaveUp: () => undefined,
      setTimeout: ((fn: () => void) => (timers.push(fn), 1)) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
    });
    poller.start();
    poller.stop();
    for (let k = 0; k < 5; k++) await Promise.resolve();
    expect(seen).toBe(0);
    expect(poller.running).toBe(false);
  });
});
