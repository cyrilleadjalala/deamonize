import { describe, expect, it } from 'vitest';
import { createApprovalWatcher } from '../../../kiro-extension/src/core/approval-watcher';
import { createActivityApi } from '../../../kiro-extension/src/core/activity-api';
import type { ActivityApi } from '../../../kiro-extension/src/core/ports';
import type { ApiResult, ApprovalRow } from '../../../kiro-extension/src/core/types';

const row = (id: string): ApprovalRow => ({
  id, tool: 'send_invoice', application: 'Billing', riskText: 'Changes data', arguments: {}, writeSteps: [], secondsLeft: 90, kind: 'tool-call',
});
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function setup(script: Array<ApprovalRow[] | 'fail' | 'throw'>) {
  const timers: Array<{ ms: number; fn: () => void }> = [];
  const notified: string[] = [];
  const cleared: string[] = [];
  let polls = 0;
  const api = {
    approvals: async (): Promise<ApiResult<ApprovalRow[]>> => {
      const next = script[Math.min(polls++, script.length - 1)];
      if (next === 'throw') throw new Error('network');
      return next === 'fail' ? { ok: false, status: 500, error: 'x' } : { ok: true, status: 200, data: next };
    },
  } as unknown as ActivityApi;
  const watcher = createApprovalWatcher({
    api: () => api,
    notify: (r) => notified.push(r.id),
    clear: (id) => cleared.push(id),
    setTimeout: ((fn: () => void, ms: number) => { timers.push({ ms, fn }); return timers.length; }) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
  });
  const fire = async (): Promise<void> => { const t = timers.shift(); t?.fn(); await flush(); };
  return { watcher, timers, notified, cleared, fire, polls: () => polls };
}

describe('approval watcher', () => {
  it('announces a new id once, keeps the list, and clears an id that left', async () => {
    const s = setup([[row('a')], [row('a'), row('b')], [row('b')]]);
    s.watcher.start();
    await flush();
    expect(s.notified).toEqual(['a']);
    expect(s.timers[0].ms).toBe(2000);
    await s.fire();
    expect(s.notified).toEqual(['a', 'b']);
    expect(s.watcher.pending.map((r) => r.id)).toEqual(['a', 'b']);
    await s.fire();
    expect(s.cleared).toEqual(['a']);
    expect(s.watcher.pending.map((r) => r.id)).toEqual(['b']);
  });

  it('backs off after failures and returns to 2 s after a success', async () => {
    const s = setup(['fail', 'throw', 'fail', 'fail', 'fail', [row('a')]]);
    s.watcher.start();
    await flush();
    const waits: number[] = [s.timers[0].ms];
    for (let i = 0; i < 5; i++) { await s.fire(); waits.push(s.timers[0].ms); }
    expect(waits).toEqual([4000, 8000, 10000, 10000, 10000, 2000]);
  });

  it('start twice runs one loop; stop ends it', async () => {
    const s = setup([[]]);
    s.watcher.start();
    s.watcher.start();
    await flush();
    expect(s.polls()).toBe(1);
    expect(s.timers).toHaveLength(1);
    s.watcher.stop();
    s.timers.shift()?.fn();
    await flush();
    expect(s.polls()).toBe(1);
  });
});

describe('activity api', () => {
  it('reads only the two read routes and drops arguments and outcome text', async () => {
    const gets: string[] = [];
    const api = createActivityApi({
      get: async (path) => {
        gets.push(path);
        return path.startsWith('/api/approvals')
          ? { status: 200, body: { pending: [{ id: 'a'.repeat(32), tool: 't', application: 'App', riskText: 'Changes data', arguments: { x: 1 }, secondsLeft: 5, kind: 'tool-call' }], serverTime: 'z' } }
          : { status: 200, body: { entries: [{ at: '2025-01-01T00:00:00Z', tool: 't', decision: 'approved', outcome: 'success', arguments: { secret: 's' } }, { at: 'x', tool: 'u', decision: 'weird' }], tools: [], total: 2 } };
      },
      post: async () => ({ status: 404, body: { error: 'Ended' } }),
    });
    const a = await api.approvals();
    const b = await api.activity(5);
    expect(a.ok && a.data[0].id).toBe('a'.repeat(32));
    expect(b.ok && b.data).toEqual([{ at: '2025-01-01T00:00:00Z', tool: 't', decision: 'approved', success: true }]);
    expect(gets).toEqual(['/api/approvals', '/api/activity?limit=5']);
    const d = await api.decide('a'.repeat(32), 'denied');
    expect(d).toEqual({ ok: false, status: 404, error: 'Ended' });
  });
});
