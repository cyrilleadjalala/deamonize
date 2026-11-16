import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Replayer } from '../../src/replayer/replayer.js';
import { extractResult } from '../../src/replayer/result-extractor.js';
import type { SandboxDriver } from '../../src/sandbox/driver.js';
import type { RecordedAction, ScreenContent, Workflow } from '../../src/types.js';

function screen(raw: string): ScreenContent {
  return { type: 'dom', raw, normalized: raw, capturedAt: 0 };
}

function makeDriver(
  execute: (action: RecordedAction) => Promise<ScreenContent>,
): SandboxDriver & { stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => { }),
    captureScreen: vi.fn(async () => screen('<html><body>start</body></html>')),
    execute: vi.fn(execute),
    stop: vi.fn(async () => { }),
    onUnexpectedExit: new EventEmitter(),
  };
}

const workflow: Workflow = {
  id: 'wf-1',
  label: 'Create customer',
  steps: [
    { actionType: 'type', selectors: ['role=textbox[name="Name"]', '#name'], variable: 'name' },
    { actionType: 'click', selectors: ['#save'] },
  ],
  variables: [{ name: 'name' }],
  observedPayloads: [],
};

describe('Replayer', () => {
  it('replays every step with payload values and returns structured content', async () => {
    const executed: RecordedAction[] = [];
    const driver = makeDriver(async (action) => {
      executed.push(action);
      return screen('<html><head><title>Done</title></head><body><p>Saved Ada</p></body></html>');
    });

    const result = await new Replayer(() => driver).replay(workflow, { name: 'Ada' });

    expect(result.success).toBe(true);
    expect(executed[0]).toMatchObject({ actionType: 'type', selector: 'role=textbox[name="Name"]', value: 'Ada' });
    expect(executed[1]).toMatchObject({ actionType: 'click', selector: '#save' });
    expect(result.result).toEqual({ screenType: 'dom', title: 'Done', text: 'Saved Ada' });
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next selector when the first one fails', async () => {
    const tried: string[] = [];
    const driver = makeDriver(async (action) => {
      tried.push(action.selector ?? '');
      if (action.selector?.startsWith('role=')) {
        throw new Error('not found');
      }
      return screen('<body>ok</body>');
    });

    const result = await new Replayer(() => driver).replay(workflow, { name: 'Ada' });

    expect(result.success).toBe(true);
    expect(tried.slice(0, 2)).toEqual(['role=textbox[name="Name"]', '#name']);
  });

  it('returns a timeout error and still stops the sandbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const driver = makeDriver(() => new Promise<ScreenContent>(() => { }));

    const result = await new Replayer(() => driver).replay(workflow, { name: 'Ada' }, 50);

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(driver.stop).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('returns sandbox_unavailable immediately when the sandbox cannot start', async () => {
    const driver = makeDriver(async () => screen(''));
    driver.start.mockRejectedValue(new Error('docker down'));

    const result = await new Replayer(() => driver).replay(workflow, { name: 'Ada' });

    expect(result).toMatchObject({ success: false, error: 'sandbox_unavailable' });
    expect(driver.execute).not.toHaveBeenCalled();
  });

  it('starts a fresh sandbox on every call', async () => {
    const factory = vi.fn(() => makeDriver(async () => screen('<body>ok</body>')));
    const replayer = new Replayer(factory);

    await replayer.replay(workflow, { name: 'Ada' });
    await replayer.replay(workflow, { name: 'Bob' });

    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('extractResult', () => {
  it('strips scripts, styles and tags from a DOM screen', () => {
    const result = extractResult(
      screen('<html><head><title>T &amp; Co</title></head><body><script>x()</script><h1>Hello</h1><p>World</p></body></html>')
    );
    expect(result).toEqual({ screenType: 'dom', title: 'T & Co', text: 'Hello\nWorld' });
  });

  it('returns the terminal buffer as text', () => {
    const result = extractResult({ type: 'terminal', raw: 'done  \n', normalized: 'done', capturedAt: 0 });
    expect(result).toEqual({ screenType: 'terminal', text: 'done' });
  });
});

describe('Replayer with a Result_Zone', () => {
  const zoned = (resultZone: Workflow['resultZone']): Workflow => ({ ...workflow, resultZone });
  const noisy = screen('<html><head><title>Done</title></head><body><nav>Menu</nav><p>Saved Ada</p></body></html>');

  it('returns the data and the text of the zone read by the driver, not the whole page', async () => {
    const driver = makeDriver(async () => noisy);
    driver.extractZone = vi.fn(async () => ({ ok: true as const, text: 'ID\n1', data: [{ ID: '1' }] }));
    const zone = { selector: '#t', extractor: { kind: 'table' as const } };

    const result = await new Replayer(() => driver).replay(zoned(zone), { name: 'Ada' });

    expect(driver.extractZone).toHaveBeenCalledWith(zone);
    expect(result.result).toEqual({ screenType: 'dom', title: 'Done', text: 'ID\n1', data: [{ ID: '1' }] });
  });

  it('reads a terminal zone from the screen text', async () => {
    const driver = makeDriver(async () => ({ type: 'terminal', raw: 'Title\nStatus: OK (2)\n', normalized: '', capturedAt: 0 }));

    const result = await new Replayer(() => driver).replay(
      zoned({ rect: { row: 1, col: 0, rows: 1, cols: 30 }, extractor: { kind: 'regex', pattern: 'Status: (?<state>\\w+)' } }),
      { name: 'Ada' }
    );

    expect(result.result).toEqual({ screenType: 'terminal', text: 'Status: OK (2)', data: { state: 'OK' } });
  });

  it('fails strictly, and says the action already ran, when the zone matches nothing', async () => {
    const driver = makeDriver(async () => noisy);
    driver.extractZone = vi.fn(async () => ({
      ok: false as const,
      error: 'result_zone_not_found' as const,
      message: 'The steps of the workflow already ran',
      zone: { selector: '#nope' },
    }));

    const result = await new Replayer(() => driver).replay(zoned({ selector: '#nope' }), { name: 'Ada' });

    expect(result).toMatchObject({ success: false, error: 'result_zone_not_found', drifted: true, failure: { zone: { selector: '#nope' } } });
    expect(result.message).toMatch(/already ran/);
    expect(driver.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the whole-page result when the workflow has no zone', async () => {
    const driver = makeDriver(async () => noisy);

    const result = await new Replayer(() => driver).replay(workflow, { name: 'Ada' });

    expect(result.result).toEqual({ screenType: 'dom', title: 'Done', text: 'Menu Saved Ada' });
    expect(result.result).not.toHaveProperty('data');
  });
});
