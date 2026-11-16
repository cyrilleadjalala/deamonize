import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Replayer } from '../../src/replayer/replayer.js';
import type { SandboxDriver } from '../../src/sandbox/driver.js';
import type { RecordedAction, ScreenContent, Workflow } from '../../src/types.js';

const screen = (raw: string): ScreenContent => ({ type: 'dom', raw, normalized: raw, capturedAt: 0 });

/** A driver that records every action it is asked to perform and fails for the selectors it is told to. */
function fakeDriver(failing: (action: RecordedAction) => boolean) {
  const performed: RecordedAction[] = [];
  const driver: SandboxDriver & { stop: ReturnType<typeof vi.fn> } = {
    start: vi.fn(async () => { }),
    captureScreen: vi.fn(async () => screen('<body>start</body>')),
    execute: vi.fn(async (action: RecordedAction) => {
      performed.push(action);
      if (failing(action)) throw new Error('no element matched ' + action.selector);
      return screen('<body>ok</body>');
    }),
    stop: vi.fn(async () => { }),
    onUnexpectedExit: new EventEmitter(),
  };
  return { driver, performed };
}

const step = (n: number, extra: Partial<Workflow['steps'][number]> = {}) => ({
  actionType: 'click' as const,
  selectors: [`#step${n}`],
  label: `click step ${n}`,
  ...extra,
});

const workflow = (steps: Workflow['steps']): Workflow => ({ id: 'wf', label: 'Four steps', steps, variables: [], observedPayloads: [] });

describe('strict replay with a fake driver', () => {
  it('stops at the failing step 2 of 4: steps 3 and 4 never run, and the result is drifted', async () => {
    const { driver, performed } = fakeDriver((a) => a.selector === '#step2');
    const wf = workflow([1, 2, 3, 4].map((n) => step(n)));
    wf.steps[1] = step(2, { risk: 'write' });

    const result = await new Replayer(() => driver).replay(wf, {});

    expect(performed.map((a) => a.selector)).toEqual(['#step1', '#step2']);
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed' });
    expect(result.failure).toMatchObject({
      stepIndex: 1,
      label: 'click step 2',
      action: 'click',
      risk: 'write',
      tried: ['#step2'],
    });
    expect(result.failure?.reason).toContain('no element matched #step2');
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  it('never retries a write or delete step with another selector, but does for a read step', async () => {
    const readRun = fakeDriver((a) => a.selector === '#a');
    const read = workflow([{ actionType: 'click', selectors: ['#a', '#b'] }]);
    expect((await new Replayer(() => readRun.driver).replay(read, {})).success).toBe(true);
    expect(readRun.performed.map((a) => a.selector)).toEqual(['#a', '#b']);

    const writeRun = fakeDriver((a) => a.selector === '#a');
    const write = workflow([{ actionType: 'click', selectors: ['#a', '#b'], risk: 'delete' }]);
    const result = await new Replayer(() => writeRun.driver).replay(write, {});
    expect(writeRun.performed.map((a) => a.selector)).toEqual(['#a']);
    expect(result).toMatchObject({ success: false, drifted: true, error: 'step_failed' });
  });

  it('succeeds without a drift flag from the strict path when every step works', async () => {
    const { driver, performed } = fakeDriver(() => false);
    const result = await new Replayer(() => driver).replay(workflow([1, 2, 3, 4].map((n) => step(n))), {});
    expect(performed).toHaveLength(4);
    expect(result.success).toBe(true);
    expect(result.failure).toBeUndefined();
  });
});
