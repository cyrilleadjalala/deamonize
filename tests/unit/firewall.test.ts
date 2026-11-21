import { mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_MESSAGES, createFirewall } from '../../src/replay/runtime/firewall.js';
import type { FirewallConfig, ToolHandler } from '../../src/replay/runtime/firewall.js';
import { openApprovalStore, writeHeartbeat } from '../../src/replay/runtime/approval-queue.js';
import { readAuditEntries } from '../../src/replay/runtime/audit-log.js';
import { startApproverSim } from '../helpers/approver-sim.js';

const config: FirewallConfig = {
  application: 'https://app.example.com',
  targetType: 'web',
  tools: {
    create_invoice: {
      risk: 'write',
      writeSteps: [{ index: 1, label: 'Save', risk: 'write' }],
      sensitiveArgs: ['pw'],
      secretVariables: [],
      steps: [{ label: 'Open', actionType: 'navigate' }, { label: 'Save', actionType: 'click', risk: 'write' }],
    },
    list_invoices: { risk: 'read', writeSteps: [], sensitiveArgs: [], secretVariables: [], steps: [{ label: 'Open', actionType: 'navigate' }] },
  },
};

let dataDir: string;
let calls: Array<Record<string, unknown>>;
const handler: ToolHandler = async (args) => {
  calls.push(args);
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, elapsedMs: 3, mode: 'strict' }) }], isError: false };
};
const decorate = (r: object): object => ({ ...r, mode: 'strict' });
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DAEMONIZE_ASK_BEFORE_CHANGES: 'true', DAEMONIZE_DATA_DIR: dataDir, ...extra });
const call = (tool: string, e: NodeJS.ProcessEnv, args: Record<string, unknown> = { customer: 'Ada', pw: 'p4ssw0rd-planted' }) =>
  createFirewall(config, decorate, e).wrap(tool, handler, () => null)(args);
const body = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dmz-fw-'));
  calls = [];
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('firewall: fail closed', () => {
  it('denied runs zero steps and writes a denied entry', async () => {
    const sim = await startApproverSim({ dataDir, decision: 'denied' });
    try {
      const r = await call('create_invoice', env());
      expect(calls).toHaveLength(0);
      expect(r.isError).toBe(true);
      expect(body(r)).toMatchObject({ success: false, error: 'approval_denied', message: APPROVAL_MESSAGES.approval_denied });
    } finally {
      await sim.stop();
    }
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'denied', outcome: 'approval_denied', source: 'kiro', risk: 'write' });
  });

  it('timeout runs zero steps and writes a timeout entry', async () => {
    const sim = await startApproverSim({ dataDir, decision: 'ignore' });
    try {
      const r = await call('create_invoice', env({ DAEMONIZE_APPROVAL_TIMEOUT_MS: '5000' }));
      expect(calls).toHaveLength(0);
      expect(body(r)).toMatchObject({ error: 'approval_timeout', message: APPROVAL_MESSAGES.approval_timeout });
    } finally {
      await sim.stop();
    }
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'timeout', outcome: 'approval_timeout' });
  }, 20_000);

  it('no heartbeat answers approval_unavailable within 5 s and runs zero steps', async () => {
    const started = Date.now();
    const r = await call('create_invoice', env());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toHaveLength(0);
    expect(body(r)).toMatchObject({ error: 'approval_unavailable', message: APPROVAL_MESSAGES.approval_unavailable });
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'unavailable', outcome: 'approval_unavailable' });
  });

  it('a stale heartbeat is no approver', async () => {
    const store = await openApprovalStore(dataDir);
    await writeHeartbeat(store!, Date.now() - 60_000);
    const r = await call('create_invoice', env());
    expect(calls).toHaveLength(0);
    expect(body(r).error).toBe('approval_unavailable');
  });

  it('a heartbeat with a wrong mac is no approver', async () => {
    const store = await openApprovalStore(dataDir);
    await writeFile(join(store!.dir, 'approver.json'), JSON.stringify({ v: 1, pid: process.pid, at: Date.now(), mac: 'forged' }));
    const r = await call('create_invoice', env());
    expect(calls).toHaveLength(0);
    expect(body(r).error).toBe('approval_unavailable');
  });

  it('an unusable approvals folder is no approver', async () => {
    await writeFile(join(dataDir, 'approvals'), 'a file where the folder should be');
    const r = await call('create_invoice', env());
    expect(calls).toHaveLength(0);
    expect(body(r).error).toBe('approval_unavailable');
  });

  it('a withdrawn question (cancelled call) runs zero steps and logs cancelled', async () => {
    const sim = await startApproverSim({ dataDir, decision: 'ignore' });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const r = await createFirewall(config, decorate, env()).wrap('create_invoice', handler, () => null)({ customer: 'Ada' }, { signal: controller.signal });
      expect(calls).toHaveLength(0);
      expect(body(r).error).toBe('approval_denied');
    } finally {
      await sim.stop();
    }
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'denied', outcome: 'cancelled' });
  });

  it('approved runs the handler once with unchanged arguments and no approval field in the answer', async () => {
    const sim = await startApproverSim({ dataDir, decision: 'approved' });
    const args = { customer: 'Ada', pw: 'p4ssw0rd-planted', _timeoutMs: 1234 };
    try {
      const r = await call('create_invoice', env(), args);
      expect(calls).toEqual([args]);
      expect(body(r)).toEqual({ success: true, elapsedMs: 3, mode: 'strict' });
      expect(sim.seen).toHaveLength(1);
      expect(JSON.stringify(sim.seen[0])).not.toContain('p4ssw0rd-planted');
    } finally {
      await sim.stop();
    }
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'approved', outcome: 'success' });
    expect(JSON.stringify(entry)).not.toContain('p4ssw0rd-planted');
  });

  it('a read tool is never held', async () => {
    const r = await call('list_invoices', env(), {});
    expect(calls).toHaveLength(1);
    expect(body(r).success).toBe(true);
    expect(await readdir(dataDir)).not.toContain('approvals');
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'auto', risk: 'read' });
  });

  it('setting off and source studio create no request file', async () => {
    await call('create_invoice', env({ DAEMONIZE_ASK_BEFORE_CHANGES: 'false' }));
    await call('create_invoice', env({ DAEMONIZE_CALL_SOURCE: 'studio' }));
    await call('create_invoice', env({ DAEMONIZE_ASK_BEFORE_CHANGES: 'TRUE' }));
    expect(calls).toHaveLength(3);
    expect(await readdir(dataDir)).not.toContain('approvals');
    const entries = await readAuditEntries(dataDir);
    expect(entries.map((e) => [e.source, e.decision])).toEqual([['kiro', 'auto'], ['studio', 'auto'], ['kiro', 'auto']]);
  });

  it('a payload that fails validation answers with the handler error and creates no request', async () => {
    const failing: ToolHandler = async () => ({ content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'validation' }) }], isError: true });
    const r = await createFirewall(config, decorate, env()).wrap('create_invoice', failing, () => [{ path: '/x' }])({ bad: 1 });
    expect(body(r).error).toBe('validation');
    expect(await readdir(dataDir)).not.toContain('approvals');
    const [entry] = await readAuditEntries(dataDir);
    expect(entry).toMatchObject({ decision: 'auto', outcome: 'validation' });
  });

  it('adds trace only with DAEMONIZE_TRACE=1 and keeps the rest of the answer', async () => {
    const plain = await call('list_invoices', env());
    const traced = await call('list_invoices', env({ DAEMONIZE_TRACE: '1' }));
    expect(body(plain)).not.toHaveProperty('trace');
    const { trace, ...rest } = body(traced);
    expect(Array.isArray(trace)).toBe(true);
    expect(rest).toEqual(body(plain));
    const text = await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
  });
});
