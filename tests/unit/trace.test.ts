import { describe, expect, it } from 'vitest';
import { NOT_REPEATED_NOTE, TRACE_MAX_STEPS, buildTrace, enterTraceScope, sanitizeTrace, takeMarks, traceScope, traceStep } from '../../src/replay/runtime/trace.js';

const steps = (n: number, risk?: 'read' | 'write' | 'delete') => Array.from({ length: n }, (_, i) => ({ label: `Step ${i}`, actionType: 'click', risk }));
const marks = (...indexes: number[]) => ({ startedAt: 0, marks: indexes.map((index, i) => ({ index, at: i * 100 })) });

describe('buildTrace', () => {
  it('maps http, accessibility, vision and terminal levels', () => {
    const result = { success: true, levels: ['http', 'dom', 'dom'], healedSteps: [2], elapsedMs: 1000 };
    const web = buildTrace({ steps: steps(3), marks: marks(0, 1, 2), result, targetType: 'web', endedAt: 300 });
    expect(web.steps.map((s) => s.level)).toEqual(['http', 'accessibility', 'vision']);
    expect(web.steps.map((s) => s.durationMs)).toEqual([100, 100, 100]);
    const tui = buildTrace({ steps: steps(2), marks: marks(0, 1), result: { success: true }, targetType: 'tui', endedAt: 100 });
    expect(tui.steps.map((s) => s.level)).toEqual(['terminal', 'terminal']);
  });

  it('marks skipped steps and steps after the failure', () => {
    const t = buildTrace({
      steps: steps(4),
      marks: marks(0, 1, 2),
      result: { success: false, error: 'timeout', skippedSteps: [0], failure: { stepIndex: 2 } },
      targetType: 'web',
      endedAt: 300,
    });
    expect(t.steps.map((s) => s.status)).toEqual(['skipped', 'ok', 'failed', 'not_run']);
    expect(t.steps[2].note).toBe('Timed out');
  });

  it('a drifted failure is drifted, and a failed HTTP write step carries the note', () => {
    const drifted = buildTrace({ steps: steps(2), marks: marks(0, 1), result: { success: false, drifted: true, error: 'drift', failure: { stepIndex: 1 } }, targetType: 'web', endedAt: 200 });
    expect(drifted.steps[1].status).toBe('drifted');
    const http = buildTrace({ steps: steps(2, 'write'), marks: marks(0, 1), result: { success: false, error: 'http_failed', levels: ['http', 'http'], failure: { stepIndex: 1 } }, targetType: 'web', endedAt: 200 });
    expect(http.steps[1]).toMatchObject({ status: 'failed', note: NOT_REPEATED_NOTE, level: 'http' });
    expect(http.steps.map((s) => s.status)).not.toContain('blocked');
  });

  it('a refused call has every step not_run, and the last step of a drifted success is drifted', () => {
    const refused = buildTrace({ steps: steps(3), marks: marks(), result: { success: false, error: 'approval_denied' }, targetType: 'web', refused: true });
    expect(refused.steps.every((s) => s.status === 'not_run' && s.level === 'not_run' && s.durationMs === 0)).toBe(true);
    const ok = buildTrace({ steps: steps(2), marks: marks(0, 1), result: { success: true, drifted: true }, targetType: 'web', endedAt: 200 });
    expect(ok.steps.map((s) => s.status)).toEqual(['ok', 'drifted']);
  });

  it('caps at 200 steps and scrubs labels', () => {
    const many = buildTrace({ steps: steps(250), marks: marks(), result: { success: true }, targetType: 'web' });
    expect(many.steps).toHaveLength(TRACE_MAX_STEPS);
    expect(many.truncated).toBe(true);
    const s = buildTrace({ steps: [{ label: `type my-secret-value ${'x'.repeat(300)}`, actionType: 'type' }], marks: marks(0), result: { success: true }, targetType: 'web', secrets: ['my-secret-value'] });
    expect(s.steps[0].label).not.toContain('my-secret-value');
    expect(s.steps[0].label.length).toBeLessThanOrEqual(120);
  });

  it('durations never exceed elapsedMs + 50', () => {
    const t = buildTrace({ steps: steps(2), marks: marks(0, 1), result: { success: true, elapsedMs: 10 }, targetType: 'web', endedAt: 5000 });
    expect(t.steps.reduce((a, s) => a + s.durationMs, 0)).toBeLessThanOrEqual(60);
  });
});

describe('trace scope', () => {
  it('traceStep is a no-op without a scope and collects inside one', async () => {
    traceStep(1);
    const { value, marks: collected } = await traceScope(async () => {
      traceStep(0);
      await new Promise((r) => setTimeout(r, 5));
      traceStep(1);
      return 'done';
    });
    expect(value).toBe('done');
    expect(collected.marks.map((m) => m.index)).toEqual([0, 1]);
  });

  it('two concurrent scopes never mix', async () => {
    const run = (id: number) => traceScope(async () => {
      for (let i = 0; i < 5; i += 1) {
        traceStep(id * 10 + i);
        await new Promise((r) => setTimeout(r, 1 + id));
      }
    });
    const [a, b] = await Promise.all([run(1), run(2)]);
    expect(a.marks.marks.map((m) => m.index)).toEqual([10, 11, 12, 13, 14]);
    expect(b.marks.marks.map((m) => m.index)).toEqual([20, 21, 22, 23, 24]);
  });

  it('enterTraceScope keeps a scope until the end of the process', async () => {
    await new Promise<void>((resolve) => setImmediate(() => {
      enterTraceScope();
      traceStep(7);
      expect(takeMarks().marks.map((m) => m.index)).toEqual([7]);
      resolve();
    }));
  });
});

describe('sanitizeTrace', () => {
  it('keeps valid steps only and caps at 200', () => {
    const good = { index: 0, label: 'a', level: 'http', durationMs: 5, status: 'ok' };
    expect(sanitizeTrace('x')).toBeUndefined();
    expect(sanitizeTrace([good, { ...good, level: 'bogus' }, null, { ...good, index: -1 }, { ...good, index: 1, label: 'y'.repeat(500) }])).toHaveLength(2);
    expect(sanitizeTrace(Array.from({ length: 300 }, (_, i) => ({ ...good, index: i })))).toHaveLength(200);
  });
});
