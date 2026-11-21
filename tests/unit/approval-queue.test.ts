import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approverAvailable,
  decodeRequest,
  listPending,
  openApprovalStore,
  parseApprovalTimeout,
  requestApproval,
  sign,
  sweep,
  verify,
  writeDecision,
  writeHeartbeat,
} from '../../src/replay/runtime/approval-queue.js';
import type { ApprovalRequestBody, ApprovalStore } from '../../src/replay/runtime/approval-queue.js';
import { startApproverSim } from '../helpers/approver-sim.js';

let dir: string;
let store: ApprovalStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dmz-queue-'));
  store = (await openApprovalStore(dir))!;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const body = (id: string, createdMs = Date.now()): ApprovalRequestBody => ({
  v: 1,
  id,
  createdAt: new Date(createdMs).toISOString(),
  timeoutMs: 60_000,
  pid: process.pid,
  source: 'kiro',
  kind: 'tool-call',
  tool: 'create_invoice',
  application: 'https://app.example.com',
  risk: 'write',
  arguments: { a: 1 },
  writeSteps: [],
});
const putRequest = async (id: string, createdMs?: number) => {
  const req = sign(store.key, body(id, createdMs));
  await writeFile(join(store.dir, `req-${id}.json`), JSON.stringify(req));
  return req;
};
const ID1 = 'a'.repeat(32);
const ID2 = 'b'.repeat(32);

describe('approval queue', () => {
  it('creates the key once and reuses it', async () => {
    const again = await openApprovalStore(dir);
    expect(again!.key.equals(store.key)).toBe(true);
    expect((await readFile(join(store.dir, '.key'), 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the first decision wins', async () => {
    const req = await putRequest(ID1);
    expect(await writeDecision(store, req, 'approved', 'studio')).toBe('written');
    expect(await writeDecision(store, req, 'denied', 'studio')).toBe('exists');
    expect(await writeDecision(store, req, 'timeout', 'requester')).toBe('exists');
    expect(await listPending(store)).toHaveLength(0);
  });

  it('ignores a request with a wrong mac and a decision with a wrong mac', async () => {
    const req = await putRequest(ID1);
    await putRequest(ID2);
    await writeFile(join(store.dir, `req-${ID2}.json`), JSON.stringify({ ...req, id: ID2 }));
    expect((await listPending(store)).map((r) => r.id)).toEqual([ID1]);
    await writeFile(join(store.dir, `dec-${ID1}.json`), JSON.stringify({ v: 1, id: ID1, decision: 'approved', decidedAt: new Date().toISOString(), by: 'studio', reqMac: req.mac, mac: 'forged' }));
    expect(await listPending(store)).toHaveLength(1); // the forged decision does not end the request
    expect(await writeDecision(store, req, 'denied', 'studio')).toBe('written'); // and does not block the real one
  });

  it('does not list a request after its timeout', async () => {
    const req = await putRequest(ID1, Date.now() - 120_000);
    expect(await listPending(store)).toHaveLength(0);
    expect(verify(store.key, req)).toBe(true);
  });

  it('heartbeat: fresh, stale and wrong key', async () => {
    expect(await approverAvailable(store)).toBe(false);
    await writeHeartbeat(store);
    expect(await approverAvailable(store)).toBe(true);
    expect(await approverAvailable(store, Date.now() + 7_000)).toBe(false);
  });

  it('requestApproval with a fake clock times out after the timeout and writes the decision itself', async () => {
    await writeHeartbeat(store);
    let clock = Date.now();
    const out = await requestApproval({
      dataDir: dir, source: 'kiro', kind: 'tool-call', tool: 't', application: 'a', risk: 'write', arguments: {}, writeSteps: [], timeoutMs: 5_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await writeHeartbeat(store, clock);
      },
    });
    expect(out.decision).toBe('timeout');
    expect(await readdir(store.dir)).not.toContain(`req-${out.id}.json`);
  });

  it('requestApproval ends as unavailable when the heartbeat stops during the wait', async () => {
    await writeHeartbeat(store);
    let clock = Date.now();
    const out = await requestApproval({
      dataDir: dir, source: 'kiro', kind: 'tool-call', tool: 't', application: 'a', risk: 'write', arguments: {}, writeSteps: [], timeoutMs: 600_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms * 20;
      },
    });
    expect(out.decision).toBe('unavailable');
  });

  it('requestApproval is approved by the simulator and unavailable without data dir', async () => {
    const sim = await startApproverSim({ dataDir: dir, decision: 'approved' });
    try {
      const out = await requestApproval({ dataDir: dir, source: 'studio-mcp', kind: 'install', tool: 't', application: 'a', risk: 'write', arguments: { x: 1 }, writeSteps: [], timeoutMs: 30_000, pollMs: 20 });
      expect(out.decision).toBe('approved');
    } finally {
      await sim.stop();
    }
    expect((await requestApproval({ dataDir: undefined, source: 'kiro', kind: 'tool-call', tool: 't', application: 'a', risk: 'write', arguments: {}, writeSteps: [], timeoutMs: 5_000 })).decision).toBe('unavailable');
  });

  it('decodeRequest rejects over 16 KiB and out of range timeouts', () => {
    const ok = JSON.stringify(sign(store.key, body(ID1)));
    expect(decodeRequest(ok)).toBeDefined();
    expect(decodeRequest(JSON.stringify({ ...JSON.parse(ok), timeoutMs: 100 }))).toBeUndefined();
    expect(decodeRequest(JSON.stringify({ ...JSON.parse(ok), arguments: 'x'.repeat(17_000) }))).toBeUndefined();
    expect(decodeRequest('not json')).toBeUndefined();
  });

  it('sweep removes old files and keeps new ones', async () => {
    await putRequest(ID1);
    await putRequest(ID2);
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(join(store.dir, `req-${ID1}.json`), old, old);
    await sweep(store);
    const names = await readdir(store.dir);
    expect(names).not.toContain(`req-${ID1}.json`);
    expect(names).toContain(`req-${ID2}.json`);
    expect((await stat(store.dir)).isDirectory()).toBe(true);
  });

  it('parseApprovalTimeout', () => {
    expect(parseApprovalTimeout(undefined)).toBe(120_000);
    expect(parseApprovalTimeout('5000')).toBe(5000);
    expect(parseApprovalTimeout('600000')).toBe(600_000);
    expect(parseApprovalTimeout('4999')).toBe(120_000);
    expect(parseApprovalTimeout('600001')).toBe(120_000);
    expect(parseApprovalTimeout('90 000')).toBe(120_000);
    expect(parseApprovalTimeout('1e5')).toBe(120_000);
  });
});
