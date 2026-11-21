import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// Real files and real timers: allow a loaded machine more than the default 30 s.
vi.setConfig({ testTimeout: 180_000 });
import { APPROVAL_MESSAGES, createFirewall } from '../../src/replay/runtime/firewall.js';
import type { FirewallConfig, ToolHandler } from '../../src/replay/runtime/firewall.js';
import { APPROVAL_MAX_PENDING, openApprovalStore, sign, encodeRecord, writeHeartbeat } from '../../src/replay/runtime/approval-queue.js';
import { readAuditEntries } from '../../src/replay/runtime/audit-log.js';
import { startApproverSim } from '../helpers/approver-sim.js';
import { argumentsWithSensitiveNames } from '../helpers/firewall-arbitraries.js';

const config: FirewallConfig = {
  application: 'https://app.example.com',
  targetType: 'web',
  tools: {
    w: { risk: 'write', writeSteps: [{ index: 0, label: 'Save', risk: 'write' }], sensitiveArgs: [], secretVariables: [], steps: [{ label: 'Save', actionType: 'click', risk: 'write' }] },
    d: { risk: 'delete', writeSteps: [{ index: 0, label: 'Delete', risk: 'delete' }], sensitiveArgs: [], secretVariables: [], steps: [{ label: 'Delete', actionType: 'click', risk: 'delete' }] },
    r: { risk: 'read', writeSteps: [], sensitiveArgs: [], secretVariables: [], steps: [{ label: 'Read', actionType: 'click' }] },
  },
};
const decorate = (r: object): object => ({ ...r, mode: 'strict' });
const toolOf = fc.constantFrom('w', 'd');

const makeHandler = (body: object = { success: true, elapsedMs: 4, mode: 'strict' }) => {
  const calls: Array<Record<string, unknown>> = [];
  const handler: ToolHandler = async (args) => {
    calls.push(args);
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: (body as { success?: boolean }).success !== true };
  };
  return { calls, handler };
};
const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'dmz-fwp-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Refusal = 'denied' | 'withdrawn' | 'no_heartbeat' | 'stale_heartbeat' | 'wrong_mac' | 'queue_full' | 'unusable';
const expectedCode: Record<Refusal, string> = {
  denied: 'approval_denied',
  withdrawn: 'approval_denied',
  no_heartbeat: 'approval_unavailable',
  stale_heartbeat: 'approval_unavailable',
  wrong_mac: 'approval_unavailable',
  queue_full: 'approval_unavailable',
  unusable: 'approval_unavailable',
};

describe('firewall properties', () => {
  // Feature: kiro-native-agent-and-firewall, Property 14: A refused call runs nothing
  it('Property 14: a refused call runs nothing', async () => {
    /** **Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.10, 12.5, 18.2 (the timeout outcome is covered by tests/unit/firewall.test.ts and approval-queue.test.ts with a clock seam)** */
    const refusal = fc.constantFrom<Refusal>('denied', 'withdrawn', 'no_heartbeat', 'stale_heartbeat', 'wrong_mac', 'queue_full', 'unusable');
    await fc.assert(
      fc.asyncProperty(toolOf, argumentsWithSensitiveNames, refusal, async (tool, args, how) => {
        await withDir(async (dir) => {
          const { calls, handler } = makeHandler();
          let stop = async (): Promise<void> => undefined;
          const controller = new AbortController();
          if (how === 'denied' || how === 'withdrawn') {
            const sim = await startApproverSim({ dataDir: dir, decision: how === 'denied' ? 'denied' : 'ignore', scanMs: 5 });
            stop = () => sim.stop();
            if (how === 'withdrawn') controller.abort();
          } else if (how === 'unusable') await writeFile(join(dir, 'approvals'), 'x');
          else {
            const store = (await openApprovalStore(dir))!;
            if (how === 'stale_heartbeat') await writeHeartbeat(store, Date.now() - 60_000);
            if (how === 'wrong_mac') await writeFile(join(store.dir, 'approver.json'), JSON.stringify({ v: 1, pid: process.pid, at: Date.now(), mac: 'forged' }));
            if (how === 'queue_full') {
              await writeHeartbeat(store);
              for (let i = 0; i < APPROVAL_MAX_PENDING; i += 1) {
                const id = i.toString(16).padStart(32, '0');
                const rec = sign(store.key, { v: 1 as const, id, createdAt: new Date().toISOString(), timeoutMs: 600_000, pid: process.pid, source: 'kiro' as const, kind: 'tool-call' as const, tool: 'x', application: 'a', risk: 'write' as const, arguments: {}, writeSteps: [] });
                await writeFile(join(store.dir, `req-${id}.json`), encodeRecord(rec));
              }
            }
          }
          try {
            const result = await createFirewall(config, decorate, { DAEMONIZE_ASK_BEFORE_CHANGES: 'true', DAEMONIZE_DATA_DIR: dir })
              .wrap(tool, handler, () => null)(args, { signal: controller.signal });
            expect(calls).toHaveLength(0);
            expect(result.isError).toBe(true);
            const body = parse(result);
            expect(body).toMatchObject({ success: false, error: expectedCode[how], message: APPROVAL_MESSAGES[expectedCode[how] as keyof typeof APPROVAL_MESSAGES] });
          } finally {
            await stop();
          }
        });
      }),
      { numRuns: 100 }
    );
  });

  it('Property 14 (approved): the handler runs once with unchanged arguments and the answer names no approval', async () => {
    /** **Validates: Requirements 11.2, 18.2** */
    await fc.assert(
      fc.asyncProperty(toolOf, argumentsWithSensitiveNames, async (tool, args) => {
        await withDir(async (dir) => {
          const { calls, handler } = makeHandler();
          const sim = await startApproverSim({ dataDir: dir, decision: 'approved', scanMs: 5 });
          try {
            const result = await createFirewall(config, decorate, { DAEMONIZE_ASK_BEFORE_CHANGES: 'true', DAEMONIZE_DATA_DIR: dir }).wrap(tool, handler, () => null)(args);
            expect(calls).toEqual([args]);
            expect(parse(result)).toEqual({ success: true, elapsedMs: 4, mode: 'strict' });
          } finally {
            await sim.stop();
          }
        });
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 15: Without a reason to ask, nothing changes
  it('Property 15: without a reason to ask, nothing changes', async () => {
    /** **Validates: Requirements 10.10, 11.7, 18.6, 28.7** */
    const noReason = fc.oneof(
      fc.record({ tool: fc.constant('r'), setting: fc.constantFrom('true', 'false', undefined), source: fc.constantFrom('studio', undefined) }),
      fc.record({ tool: toolOf, setting: fc.oneof(fc.constantFrom('TRUE', 'True', '1', 'yes', '', 'false', ' true', 'true '), fc.string({ maxLength: 8 }).filter((s) => s !== 'true'), fc.constant(undefined)), source: fc.constantFrom('studio', undefined) }),
      fc.record({ tool: toolOf, setting: fc.constant('true'), source: fc.constant('studio') })
    );
    await fc.assert(
      fc.asyncProperty(noReason, argumentsWithSensitiveNames, async ({ tool, setting, source }, args) => {
        // `source` only blocks the question when it is studio; without a source, the other branches must not ask.
        const asks = setting === 'true' && tool !== 'r' && source !== 'studio';
        fc.pre(!asks);
        await withDir(async (dir) => {
          const { calls, handler } = makeHandler();
          const env: NodeJS.ProcessEnv = { DAEMONIZE_DATA_DIR: dir };
          if (setting !== undefined) env.DAEMONIZE_ASK_BEFORE_CHANGES = setting;
          if (source !== undefined) env.DAEMONIZE_CALL_SOURCE = source;
          const wrapped = await createFirewall(config, decorate, env).wrap(tool, handler, () => null)(args);
          const direct = await handler(args);
          expect(wrapped).toEqual(direct);
          expect(calls).toHaveLength(2);
          expect(await readdir(dir)).not.toContain('approvals');
        });
        // with nothing named at all the wrapper leaves the answer alone
        const { handler: h2 } = makeHandler();
        expect(await createFirewall(config, decorate, {}).wrap(tool, h2, () => null)(args)).toEqual(await h2(args));
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 16: Validation comes first
  it('Property 16: validation comes first', async () => {
    /** **Validates: Requirements 11.6, 18.3** */
    await fc.assert(
      fc.asyncProperty(toolOf, argumentsWithSensitiveNames, fc.constantFrom('true', 'false', undefined), async (tool, args, setting) => {
        await withDir(async (dir) => {
          const bodyOf = { success: false, error: 'validation', errors: [{ path: '/x' }] };
          const answers: unknown[] = [];
          for (const value of [setting, 'true', 'false'] as const) {
            const { handler } = makeHandler(bodyOf);
            const env: NodeJS.ProcessEnv = { DAEMONIZE_DATA_DIR: dir };
            if (value !== undefined) env.DAEMONIZE_ASK_BEFORE_CHANGES = value;
            answers.push(await createFirewall(config, decorate, env).wrap(tool, handler, () => [{ path: '/x' }])(args));
          }
          expect(answers[1]).toEqual(answers[2]);
          expect(answers[0]).toEqual(answers[1]);
          expect(parse(answers[0] as { content: Array<{ text: string }> }).error).toBe('validation');
          expect(await readdir(dir)).not.toContain('approvals');
        });
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 18: Reserved arguments cannot change the gate
  it('Property 18: reserved arguments cannot change the gate', async () => {
    /** **Validates: Requirements 14.4** */
    const reserved = fc.dictionary(fc.constantFrom('_approval', '_askBeforeChanges', 'confirm', '_trace', '_timeoutMs'), fc.oneof(fc.boolean(), fc.constantFrom('true', 'approved', 'yes'), fc.integer({ min: 1, max: 600_000 })), { minKeys: 1 });
    await fc.assert(
      fc.asyncProperty(toolOf, argumentsWithSensitiveNames, reserved, fc.constantFrom('true', 'false'), async (tool, args, extras, setting) => {
        const run = async (payload: Record<string, unknown>): Promise<{ answer: unknown; ran: number }> =>
          withDir(async (dir) => {
            const { calls, handler } = makeHandler();
            const sim = await startApproverSim({ dataDir: dir, decision: 'denied', scanMs: 5 });
            try {
              const answer = await createFirewall(config, decorate, { DAEMONIZE_ASK_BEFORE_CHANGES: setting, DAEMONIZE_DATA_DIR: dir }).wrap(tool, handler, () => null)(payload);
              return { answer, ran: calls.length };
            } finally {
              await sim.stop();
            }
          });
        const plain = await run(args);
        const withReserved = await run({ ...args, ...extras });
        expect(withReserved).toEqual(plain);
        expect(plain.ran).toBe(setting === 'true' ? 0 : 1);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 23: Decision and outcome follow the gate
  it('Property 23: decision and outcome follow the gate', async () => {
    /** **Validates: Requirements 15.3, 15.4, 15.8, 15.9, 15.11** */
    const scenario = fc.record({
      tool: fc.constantFrom('w', 'd', 'r'),
      source: fc.constantFrom('studio', undefined),
      setting: fc.constantFrom('true', 'false'),
      answer: fc.constantFrom<'approved' | 'denied' | 'none'>('approved', 'denied', 'none'),
      result: fc.constantFrom<object>({ success: true, elapsedMs: 1 }, { success: false, error: 'http_failed', elapsedMs: 1 }, { success: false, error: `${'long text '.repeat(60)}`, elapsedMs: 1 }),
      brokenLog: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        await withDir(async (dir) => {
          const { calls, handler } = makeHandler(s.result);
          const asks = s.setting === 'true' && s.tool !== 'r' && s.source !== 'studio';
          const sim = s.answer === 'none' ? undefined : await startApproverSim({ dataDir: dir, decision: s.answer, scanMs: 5 });
          if (s.brokenLog) {
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'audit'), 'a file where the log folder should be');
          }
          const env: NodeJS.ProcessEnv = { DAEMONIZE_ASK_BEFORE_CHANGES: s.setting, DAEMONIZE_DATA_DIR: dir };
          if (s.source !== undefined) env.DAEMONIZE_CALL_SOURCE = s.source;
          try {
            const answer = await createFirewall(config, decorate, env).wrap(s.tool, handler, () => null)({});
            const expectedDecision = !asks ? 'auto' : s.answer === 'approved' ? 'approved' : s.answer === 'denied' ? 'denied' : 'unavailable';
            expect(calls).toHaveLength(expectedDecision === 'auto' || expectedDecision === 'approved' ? 1 : 0);
            if (expectedDecision === 'approved' || expectedDecision === 'auto') expect(answer).toEqual(await handler({}));
            if (sim !== undefined && asks) expect(sim.seen).toHaveLength(1); // the question was asked even when the log is broken
            if (s.brokenLog) return;
            const [entry] = await readAuditEntries(dir);
            expect(entry.source).toBe(s.source === 'studio' ? 'studio' : 'kiro');
            expect(entry.decision).toBe(expectedDecision);
            expect(entry.outcome.length).toBeLessThanOrEqual(200);
            const body = parse(answer);
            const expectedOutcome = expectedDecision === 'denied' ? 'approval_denied' : expectedDecision === 'unavailable' ? 'approval_unavailable' : body.success === true ? 'success' : undefined;
            if (expectedOutcome !== undefined) expect(entry.outcome).toBe(expectedOutcome);
            else expect(entry.outcome === body.error || (typeof body.error === 'string' && body.error.startsWith(entry.outcome.slice(0, 50)))).toBe(true);
          } finally {
            await sim?.stop();
          }
        });
      }),
      { numRuns: 100 }
    );
  });
});

void json;
