import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '../../src/replay/runtime/approval-queue.js';

// A local fake of the queue (the design's behaviour: first decision wins, decided and expired requests are not listed)
const fake = vi.hoisted(() => {
  const state = {
    open: true,
    pending: [] as Array<ApprovalRequestRecord & { decided?: string }>,
    heartbeats: 0,
    removed: 0,
    sweeps: 0,
  };
  return state;
});
vi.mock('../../src/replay/runtime/approval-queue.js', () => ({
  HEARTBEAT_EVERY_MS: 2000,
  openApprovalStore: async () => (fake.open ? { dir: 'fake', key: Buffer.alloc(32) } : undefined),
  writeHeartbeat: async () => {
    fake.heartbeats += 1;
  },
  removeHeartbeat: async () => {
    fake.removed += 1;
  },
  sweep: async () => {
    fake.sweeps += 1;
  },
  listPending: async (_s: unknown, now = Date.now()) => fake.pending.filter((r) => r.decided === undefined && Date.parse(r.createdAt) + r.timeoutMs > now),
  writeDecision: async (_s: unknown, req: ApprovalRequestRecord, decision: string) => {
    const found = fake.pending.find((r) => r.id === req.id);
    if (found === undefined || found.decided !== undefined) return 'exists';
    found.decided = decision;
    return 'written';
  },
}));

import { createApprovalsService } from '../../src/studio/approvals-service.js';
import type { AppData } from '../../src/studio/contracts.js';

const NOW = Date.parse('2026-01-15T10:00:00.000Z');
const ID = 'a'.repeat(32);
const record = (over: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord => ({
  v: 1,
  id: ID,
  createdAt: new Date(NOW).toISOString(),
  timeoutMs: 90_000,
  pid: 1,
  source: 'kiro',
  kind: 'tool-call',
  tool: 'create_invoice',
  application: 'https://billing.example.com',
  risk: 'write',
  arguments: { amount: 5 },
  writeSteps: [{ index: 2, label: 'Click Create', risk: 'write' }],
  mac: 'm',
  ...over,
});
const appData = (ok: boolean): AppData =>
  ({ dir: ok ? 'x' : undefined, ensure: async () => (ok ? { ok: true, dir: 'x' } : { ok: false, problem: 'unresolved' }), check: async () => (ok ? { ok: true, dir: 'x' } : { ok: false, problem: 'unresolved' }) }) as unknown as AppData;

describe('approvals service', () => {
  beforeEach(() => {
    fake.open = true;
    fake.pending = [];
    fake.heartbeats = 0;
    fake.removed = 0;
    fake.sweeps = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('lists a pending request with its risk text and the seconds left', async () => {
    fake.pending.push(record());
    const service = createApprovalsService({ appData: appData(true), now: () => NOW + 30_000 });
    await service.start();
    const [view] = await service.list();
    expect(view).toMatchObject({ id: ID, riskText: 'Changes data', secondsLeft: 60, kind: 'tool-call' });
    expect(view.expiresAt).toBe(new Date(NOW + 90_000).toISOString());
    await service.close();
  });

  it('writes the heartbeat at start and every 2 seconds, and removes it at close', async () => {
    vi.useFakeTimers();
    const service = createApprovalsService({ appData: appData(true) });
    await service.start();
    expect(fake.heartbeats).toBe(1);
    await vi.advanceTimersByTimeAsync(4100);
    expect(fake.heartbeats).toBe(3);
    await service.close();
    expect(fake.removed).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.heartbeats).toBe(3);
  });

  it('decides once: the first decision wins, a second one finds the question ended', async () => {
    fake.pending.push(record());
    const service = createApprovalsService({ appData: appData(true), now: () => NOW });
    await service.start();
    expect(await service.decide(ID, 'approved')).toEqual({ ok: true, decision: 'approved' });
    expect(await service.decide(ID, 'denied')).toEqual({ ok: false, reason: 'ended' });
    expect(fake.pending[0].decided).toBe('approved');
    await service.close();
  });

  it('answers ended for an unknown id and for an expired request', async () => {
    fake.pending.push(record());
    const service = createApprovalsService({ appData: appData(true), now: () => NOW + 200_000 });
    await service.start();
    expect(await service.decide(ID, 'approved')).toEqual({ ok: false, reason: 'ended' });
    expect(await service.decide('b'.repeat(32), 'approved')).toEqual({ ok: false, reason: 'ended' });
    expect(await service.list()).toEqual([]);
    await service.close();
  });

  it('does nothing when the data folder is unusable', async () => {
    fake.pending.push(record());
    const service = createApprovalsService({ appData: appData(false) });
    await service.start();
    expect(fake.heartbeats).toBe(0);
    expect(await service.list()).toEqual([]);
    expect(await service.decide(ID, 'approved')).toEqual({ ok: false, reason: 'ended' });
    await service.close();
    expect(fake.removed).toBe(0);
  });

  it('does nothing when the queue folder is unusable', async () => {
    fake.open = false;
    const service = createApprovalsService({ appData: appData(true) });
    await service.start();
    expect(fake.heartbeats).toBe(0);
    expect(await service.list()).toEqual([]);
    await service.close();
  });
});
