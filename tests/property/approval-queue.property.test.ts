import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// Real files and real timers: allow a loaded machine more than the default 30 s.
vi.setConfig({ testTimeout: 180_000 });
import {
  APPROVAL_MAX_TIMEOUT_MS,
  APPROVAL_MIN_TIMEOUT_MS,
  decodeDecision,
  decodeRequest,
  encodeRecord,
  listPending,
  openApprovalStore,
  parseApprovalTimeout,
  requestApproval,
  sign,
  verify,
  writeDecision,
  writeHeartbeat,
} from '../../src/replay/runtime/approval-queue.js';
import type { ApprovalDecisionBody, ApprovalDecisionValue, ApprovalRequestBody, ApprovalStore } from '../../src/replay/runtime/approval-queue.js';
import { approvalRequestBody } from '../helpers/firewall-arbitraries.js';

const KEY = Buffer.alloc(32, 7);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T; // plain JSON values (-0 becomes 0)
const normalized = (b: ApprovalRequestBody): ApprovalRequestBody => json(b);
const fitsRecord = (b: ApprovalRequestBody): boolean => Buffer.byteLength(encodeRecord(sign(KEY, b)), 'utf8') <= 16 * 1024;
const requestBody = approvalRequestBody.map(normalized).filter(fitsRecord);
const decisionValue = fc.constantFrom<ApprovalDecisionValue>('approved', 'denied', 'timeout', 'withdrawn');

const withStore = async <T>(fn: (store: ApprovalStore, dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'dmz-pq-'));
  try {
    const store = await openApprovalStore(dir);
    if (store === undefined) throw new Error('store');
    await writeHeartbeat(store);
    return await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const baseOptions = { source: 'kiro', kind: 'tool-call', tool: 't', application: 'a', risk: 'write', writeSteps: [], timeoutMs: 60_000, pollMs: 2 } as const;

describe('approval queue properties', () => {
  // Feature: kiro-native-agent-and-firewall, Property 11: Approval records round trip and resist change
  it('Property 11: records round trip and resist change', () => {
    /** **Validates: Requirements 12.9, 12.12** */
    fc.assert(
      fc.property(requestBody, requestBody, fc.nat(), fc.nat(), fc.constantFrom('x', '0', ' ', '"', '\u00e9'), (a, other, pos, _p2, ch) => {
        const record = sign(KEY, a);
        const text = encodeRecord(record);
        expect(decodeRequest(text)).toEqual(record);
        expect(verify(KEY, record)).toBe(true);
        expect(verify(Buffer.alloc(32, 8), record)).toBe(false);
        // one character changed
        const at = pos % text.length;
        const changed = `${text.slice(0, at)}${ch}${text.slice(at + 1)}`;
        const decoded = decodeRequest(changed);
        if (decoded !== undefined && verify(KEY, decoded)) expect(decoded).toEqual(record);
        // a field changed
        expect(verify(KEY, { ...record, tool: `${record.tool}x` })).toBe(false);
        expect(verify(KEY, { ...record, timeoutMs: record.timeoutMs === 5000 ? 5001 : 5000 })).toBe(false);
        // a decision moved to another request
        const decision: ApprovalDecisionBody = { v: 1, id: record.id, decision: 'approved', decidedAt: new Date(0).toISOString(), by: 'studio', reqMac: record.mac };
        const signed = sign(KEY, decision);
        expect(decodeDecision(encodeRecord(signed))).toEqual(signed);
        const otherRecord = sign(KEY, { ...other, id: record.id });
        if (otherRecord.mac !== record.mac) expect(signed.reqMac === otherRecord.mac).toBe(false);
        expect(verify(KEY, { ...signed, reqMac: otherRecord.mac })).toBe(otherRecord.mac === record.mac);
      }),
      { numRuns: 120 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 12: The first decision wins
  it('Property 12: the first decision wins', async () => {
    /** **Validates: Requirements 12.4, 12.7** */
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(decisionValue, fc.constantFrom<'studio' | 'requester'>('studio', 'requester')), { minLength: 1, maxLength: 5 }), async (sequence) => {
        await withStore(async (store, dir) => {
          const outcome = requestApproval({
            ...baseOptions,
            dataDir: dir,
            arguments: {},
            sleep: async () => {
              const [req] = await listPending(store);
              if (req === undefined) return;
              const results: string[] = [];
              for (const [decision, by] of sequence) results.push(await writeDecision(store, req, decision, by));
              expect(results).toEqual(['written', ...sequence.slice(1).map(() => 'exists')]);
            },
          });
          expect((await outcome).decision).toBe(sequence[0][0]);
        });
      }),
      { numRuns: 100 }
    );
  });

  it('Property 12 (timeout): a request after its timeout is no longer listed as pending', async () => {
    /** **Validates: Requirements 12.7** */
    await fc.assert(
      fc.asyncProperty(requestBody, fc.integer({ min: 0, max: 5_000 }), async (b, extra) => {
        await withStore(async (store) => {
          const id = b.id;
          const createdMs = Date.now() - b.timeoutMs - extra - 1;
          const req = sign(store.key, { ...b, pid: process.pid, createdAt: new Date(createdMs).toISOString() });
          const { writeFile } = await import('node:fs/promises');
          await writeFile(join(store.dir, `req-${id}.json`), encodeRecord(req));
          expect(await listPending(store)).toHaveLength(0);
          expect(await listPending(store, createdMs + 1)).toHaveLength(1);
        });
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 13: Requests are independent
  it('Property 13: requests are independent', async () => {
    /** **Validates: Requirements 12.6, 12.11** */
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<ApprovalDecisionValue>('approved', 'denied'), fc.constantFrom<ApprovalDecisionValue>('approved', 'denied'), fc.boolean(), async (da, db, aFirst) => {
        await withStore(async (store, dir) => {
          const tools = { a: da, b: db } as Record<string, ApprovalDecisionValue>;
          let decidedFirst = false;
          const run = (tool: 'a' | 'b') =>
            requestApproval({
              ...baseOptions,
              tool,
              dataDir: dir,
              arguments: { tool },
              sleep: async (ms) => {
                try {
                  const pending = await listPending(store);
                  if (pending.length === 2 && !decidedFirst) {
                    decidedFirst = true;
                    const ordered = [...pending].sort((x, y) => (aFirst ? x.tool.localeCompare(y.tool) : y.tool.localeCompare(x.tool)));
                    await writeDecision(store, ordered[0], tools[ordered[0].tool], 'studio');
                    // the other request is still pending (the first requester may already have removed its own files)
                    expect((await listPending(store)).map((r) => r.tool)).toContain(ordered[1].tool);
                    await writeDecision(store, ordered[1], tools[ordered[1].tool], 'studio');
                  }
                  await new Promise((r) => setTimeout(r, Math.min(ms, 3)));
                } finally {
                  // nothing to clean
                }
              },
            });
          const [ra, rb] = await Promise.all([run('a'), run('b')]);
          expect(ra.decision).toBe(da);
          expect(rb.decision).toBe(db);
        });
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 17: The approval timeout is bounded
  it('Property 17: the approval timeout is bounded', () => {
    /** **Validates: Requirements 12.2, 12.3** */
    const text = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer({ min: -100, max: 800_000 }).map(String),
      fc.integer({ min: 0, max: 700_000 }).map((n) => ` ${n}`),
      fc.integer({ min: 0, max: 700_000 }).map((n) => `${n}.0`),
      fc.integer({ min: 4_000, max: 7_000 }).map((n) => `${n}`),
      fc.constantFrom('5e3', '0x1388', '5000ms', '', '-5000', '\n5000', '00005000', '600000', '600001', '4999', '5000')
    );
    fc.assert(
      fc.property(text, (value) => {
        const result = parseApprovalTimeout(value);
        expect(result).toBeGreaterThanOrEqual(APPROVAL_MIN_TIMEOUT_MS);
        expect(result).toBeLessThanOrEqual(APPROVAL_MAX_TIMEOUT_MS);
        const whole = /^\d+$/.test(value) ? Number(value) : undefined;
        const expected = whole !== undefined && whole >= 5000 && whole <= 600_000 ? whole : 120_000;
        expect(result).toBe(expected);
      }),
      { numRuns: 300 }
    );
    expect(parseApprovalTimeout(undefined)).toBe(120_000);
  });
});
