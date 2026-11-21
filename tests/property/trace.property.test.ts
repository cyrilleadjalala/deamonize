import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// Real files and real timers: allow a loaded machine more than the default 30 s.
vi.setConfig({ testTimeout: 180_000 });
import { NOT_REPEATED_NOTE, TRACE_MAX_STEPS, buildTrace } from '../../src/replay/runtime/trace.js';
import type { BuildTraceInput } from '../../src/replay/runtime/trace.js';
import { createFirewall } from '../../src/replay/runtime/firewall.js';

const risk = fc.constantFrom<'read' | 'write' | 'delete' | undefined>('read', 'write', 'delete', undefined);
const stepDef = fc.record({ label: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }), actionType: fc.constantFrom('click', 'type', 'navigate'), risk });
const stepList = (max: number) => fc.array(stepDef, { minLength: 0, maxLength: max });
const subset = (n: number): fc.Arbitrary<number[]> => (n === 0 ? fc.constant([]) : fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { maxLength: n }));

describe('trace properties', () => {
  // Feature: kiro-native-agent-and-firewall, Property 24: Trace invariants
  it('Property 24: trace invariants', () => {
    /** **Validates: Requirements 22.1, 22.10, 22.12, 22.13** */
    const scenario = fc.integer({ min: 0, max: 260 }).chain((n) =>
      fc.record({
        steps: fc.array(stepDef, { minLength: n, maxLength: n }),
        gaps: fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 0, maxLength: 30 }),
        order: fc.array(fc.integer({ min: 0, max: Math.max(0, n - 1) }), { maxLength: 30 }),
        success: fc.boolean(),
        error: fc.constantFrom('timeout', 'http_failed', 'drift', undefined),
        failIndex: fc.option(fc.integer({ min: 0, max: Math.max(0, n) }), { nil: undefined }),
        skipped: subset(n),
        healed: subset(n),
        drifted: fc.boolean(),
        elapsedMs: fc.option(fc.nat({ max: 60_000 }), { nil: undefined }),
        refused: fc.boolean(),
      })
    );
    fc.assert(
      fc.property(scenario, (s) => {
        let at = 1_000;
        const marks = s.order.slice(0, s.gaps.length).map((index, i) => ({ index, at: (at += s.gaps[i]) }));
        const input: BuildTraceInput = {
          steps: s.steps,
          marks: { startedAt: 1_000, marks },
          result: {
            success: s.success,
            error: s.error,
            drifted: s.drifted,
            skippedSteps: s.skipped,
            healedSteps: s.healed,
            failure: s.failIndex === undefined ? undefined : { stepIndex: s.failIndex },
            ...(s.elapsedMs === undefined ? {} : { elapsedMs: s.elapsedMs }),
          },
          targetType: 'web',
          refused: s.refused,
          endedAt: at + 100,
        };
        const t = buildTrace(input);
        expect(t.steps).toHaveLength(Math.min(s.steps.length, TRACE_MAX_STEPS));
        expect(t.truncated).toBe(s.steps.length > TRACE_MAX_STEPS);
        t.steps.forEach((step, i) => {
          expect(step.index).toBe(i);
          expect(Number.isInteger(step.durationMs)).toBe(true);
          expect(step.durationMs).toBeGreaterThanOrEqual(0);
          expect(step.durationMs).toBeLessThanOrEqual(at + 100 - 1_000);
        });
        if (s.elapsedMs !== undefined) expect(t.steps.reduce((sum, x) => sum + x.durationMs, 0)).toBeLessThanOrEqual(s.elapsedMs + 50);
        expect(t.steps.some((x) => x.status === 'blocked')).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 25: Trace levels and statuses follow the result
  it('Property 25: trace levels and statuses follow the result', () => {
    /** **Validates: Requirements 22.2, 22.3, 22.4** */
    const scenario = fc.integer({ min: 1, max: 15 }).chain((n) =>
      fc.record({
        steps: fc.array(stepDef, { minLength: n, maxLength: n }),
        skipped: subset(n),
        healed: subset(n),
        http: subset(n),
        failAt: fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: undefined }),
        error: fc.constantFrom('http_failed', 'timeout', 'drift'),
        drifted: fc.boolean(),
        refused: fc.boolean(),
        tui: fc.boolean(),
      })
    );
    fc.assert(
      fc.property(scenario, (s) => {
        const n = s.steps.length;
        const failAt = s.failAt !== undefined && !s.skipped.includes(s.failAt) ? s.failAt : undefined;
        const levels = Array.from({ length: n }, (_, i) => (s.http.includes(i) ? 'http' : 'dom'));
        const ranUpTo = failAt ?? n - 1;
        const marks = Array.from({ length: ranUpTo + 1 }, (_, i) => ({ index: i, at: 100 + i * 10 }));
        const t = buildTrace({
          steps: s.steps,
          marks: { startedAt: 100, marks },
          result: { success: failAt === undefined, error: failAt === undefined ? undefined : s.error, drifted: s.drifted && failAt !== undefined, skippedSteps: s.skipped, healedSteps: s.healed, levels, failure: failAt === undefined ? undefined : { stepIndex: failAt } },
          targetType: s.tui ? 'tui' : 'web',
          refused: s.refused,
          endedAt: 100 + n * 10,
        });
        t.steps.forEach((step, i) => {
          if (s.refused) return expect([step.level, step.status]).toEqual(['not_run', 'not_run']);
          if (s.skipped.includes(i)) return expect([step.level, step.status]).toEqual(['skipped', 'skipped']);
          if (failAt !== undefined && i > failAt) return expect([step.level, step.status]).toEqual(['not_run', 'not_run']);
          const level = s.http.includes(i) ? 'http' : s.healed.includes(i) ? 'vision' : s.tui ? 'terminal' : 'accessibility';
          expect(step.level).toBe(level);
          if (failAt === i) {
            expect(step.status).toBe(s.drifted ? 'drifted' : 'failed');
            const risky = s.steps[i].risk === 'write' || s.steps[i].risk === 'delete';
            expect(step.note === NOT_REPEATED_NOTE).toBe(s.error === 'http_failed' && risky);
          } else expect(step.status).toBe('ok');
        });
      }),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 26: Trace is opt-in and changes nothing else
  it('Property 26: trace is opt-in and changes nothing else', async () => {
    /** **Validates: Requirements 22.5, 22.6, 22.8, 28.7** */
    const resultBody = fc.record(
      { success: fc.boolean(), mode: fc.constantFrom('strict', 'lenient'), elapsedMs: fc.nat({ max: 5000 }), error: fc.constantFrom('timeout', 'drift'), data: fc.jsonValue(), trace: fc.constant([{ index: 0, label: 'old', level: 'http', durationMs: 1, status: 'ok' }]) },
      { requiredKeys: ['success'] }
    );
    await fc.assert(
      fc.asyncProperty(resultBody, stepList(5), async (body, steps) => {
        const config = { application: 'https://a.example.com', targetType: 'web' as const, tools: { t: { risk: 'read' as const, writeSteps: [], sensitiveArgs: [], secretVariables: [], steps: steps.map((s) => ({ ...s, label: s.label ?? undefined })) } } };
        const handler = async () => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: body.success !== true });
        const off = await createFirewall(config, (r) => r, {}).wrap('t', handler, () => null)({});
        const on = await createFirewall(config, (r) => r, { DAEMONIZE_TRACE: '1' }).wrap('t', handler, () => null)({});
        const offBody = JSON.parse(off.content[0].text) as Record<string, unknown>;
        const { trace, traceTruncated: _tt, ...rest } = JSON.parse(on.content[0].text) as Record<string, unknown>;
        void _tt;
        expect('trace' in offBody).toBe(false);
        expect(Array.isArray(trace)).toBe(true);
        expect(rest).toEqual(offBody);
        const { trace: _dropped, ...withoutTrace } = body as Record<string, unknown>;
        void _dropped;
        expect(offBody).toEqual(JSON.parse(JSON.stringify(withoutTrace)));
        expect(on.isError).toBe(off.isError);
      }),
      { numRuns: 120 }
    );
  });
});
