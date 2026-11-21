/**
 * Replay trace: which step ran, how long it took and how it ended.
 * Standalone runtime module: imports only `node:*` and its siblings. Copied next to the generated server
 * and into the container image.
 *
 * `buildTrace` never produces the status `blocked` (it stays in the type for the UI).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type TraceLevel = 'http' | 'accessibility' | 'vision' | 'terminal' | 'skipped' | 'not_run';
export type TraceStatus = 'ok' | 'failed' | 'skipped' | 'not_run' | 'blocked' | 'drifted';
export interface TraceStep {
  index: number;
  label: string;
  level: TraceLevel;
  durationMs: number;
  status: TraceStatus;
  note?: string;
}

export const TRACE_MAX_STEPS = 200;
export const TRACE_LABEL_MAX = 120;
export const NOT_REPEATED_NOTE = 'Not repeated: this step changes data';

export interface TraceMarks {
  startedAt: number;
  marks: Array<{ index: number; at: number }>;
}

const scopes = new AsyncLocalStorage<TraceMarks>();
const newMarks = (): TraceMarks => ({ startedAt: Date.now(), marks: [] });

/** No-op when no scope is active, so a replay used without the wrapper behaves as before. */
export function traceStep(index: number): void {
  const store = scopes.getStore();
  if (store !== undefined && Number.isInteger(index)) store.marks.push({ index, at: Date.now() });
}

/** Runs `fn` in a scope (AsyncLocalStorage) and returns the marks it collected. */
export async function traceScope<T>(fn: () => Promise<T>): Promise<{ value: T; marks: TraceMarks }> {
  const store = newMarks();
  const value = await scopes.run(store, fn);
  return { value, marks: store };
}

/** Container entry: the process serves one call, so the scope may last until exit. */
export function enterTraceScope(): void {
  scopes.enterWith(newMarks());
}

export function takeMarks(): TraceMarks {
  const store = scopes.getStore();
  return store === undefined ? newMarks() : { startedAt: store.startedAt, marks: store.marks.map((m) => ({ ...m })) };
}

export interface BuildTraceInput {
  steps: ReadonlyArray<{ label?: string; actionType: string; risk?: 'read' | 'write' | 'delete' }>;
  marks: TraceMarks;
  /** The object the call returned (before `trace` is added). */
  result: Record<string, unknown>;
  targetType: 'web' | 'tui';
  /** The call ran no replay step at all (a refusal, a validation error). Every step is `not_run`. */
  refused?: boolean;
  /** Secret values removed from labels and notes. */
  secrets?: readonly string[];
  endedAt?: number;
}

const scrub = (text: string, secrets: readonly string[], max: number): string => {
  let out = typeof text === 'string' ? text : String(text);
  for (const secret of [...new Set(secrets)].filter((s) => typeof s === 'string' && s.length >= 3).sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('***');
  }
  if (out.length > max) {
    let end = max - 1;
    const code = out.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    out = `${out.slice(0, end)}\u2026`;
  }
  return out;
};

const indexSet = (value: unknown): Set<number> =>
  new Set(Array.isArray(value) ? value.filter((n): n is number => Number.isInteger(n) && n >= 0) : []);

export function buildTrace(input: BuildTraceInput): { steps: TraceStep[]; truncated: boolean } {
  const secrets = input.secrets ?? [];
  const result = input.result ?? {};
  const count = Math.min(input.steps.length, TRACE_MAX_STEPS);
  const truncated = input.steps.length > TRACE_MAX_STEPS;
  const endedAt = input.endedAt ?? Date.now();
  const skipped = indexSet(result.skippedSteps);
  const healed = indexSet(result.healedSteps);
  const levels = Array.isArray(result.levels) ? result.levels : [];
  const success = result.success === true;
  const drifted = result.drifted === true;
  const error = result.error;
  const failure = result.failure !== null && typeof result.failure === 'object' ? (result.failure as Record<string, unknown>) : {};

  const marks = input.marks.marks;
  // The first mark of each step, and the position of that mark in the sequence.
  const firstMark = new Map<number, number>();
  marks.forEach((m, position) => {
    if (!firstMark.has(m.index)) firstMark.set(m.index, position);
  });
  const lastRan = (() => {
    for (let p = marks.length - 1; p >= 0; p -= 1) if (!skipped.has(marks[p].index) && marks[p].index < count) return marks[p].index;
    return undefined;
  })();

  let failIndex: number | undefined;
  if (!input.refused && !success) {
    if (Number.isInteger(failure.stepIndex) && (failure.stepIndex as number) >= 0) failIndex = failure.stepIndex as number;
    else failIndex = lastRan;
  }
  const refusedAll = input.refused === true || (!success && failIndex === undefined);

  const steps: TraceStep[] = [];
  for (let i = 0; i < count; i += 1) {
    const def = input.steps[i];
    const label = scrub(def.label !== undefined && def.label !== '' ? def.label : def.actionType, secrets, TRACE_LABEL_MAX);
    if (skipped.has(i) && !input.refused) {
      steps.push({ index: i, label, level: 'skipped', durationMs: 0, status: 'skipped' });
      continue;
    }
    if (refusedAll || (failIndex !== undefined && i > failIndex)) {
      steps.push({ index: i, label, level: 'not_run', durationMs: 0, status: 'not_run' });
      continue;
    }
    const level: TraceLevel = levels[i] === 'http' ? 'http' : healed.has(i) ? 'vision' : input.targetType === 'tui' ? 'terminal' : 'accessibility';
    let durationMs = 0;
    const position = firstMark.get(i);
    if (position !== undefined) {
      const next = position + 1 < marks.length ? marks[position + 1].at : endedAt;
      durationMs = Math.max(0, Math.round(next - marks[position].at));
    }
    const step: TraceStep = { index: i, label, level, durationMs, status: 'ok' };
    if (failIndex === i) {
      step.status = drifted ? 'drifted' : 'failed';
      if (error === 'http_failed' && (def.risk === 'write' || def.risk === 'delete')) step.note = NOT_REPEATED_NOTE;
      else if (error === 'timeout') step.note = 'Timed out';
    } else if (success && drifted && lastRan === i) {
      step.status = 'drifted';
    }
    steps.push(step);
  }
  // A drifted call that succeeded with no mark: the last step that ran carries the flag.
  if (success && drifted && lastRan === undefined && !input.refused) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (steps[i].status === 'ok') {
        steps[i].status = 'drifted';
        break;
      }
    }
  }

  // The durations never add up to more than the call itself took.
  const elapsed = result.elapsedMs;
  if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) {
    const cap = Math.floor(elapsed) + 50;
    const total = steps.reduce((sum, s) => sum + s.durationMs, 0);
    if (total > cap) for (const s of steps) s.durationMs = Math.floor((s.durationMs * cap) / total);
  }
  return { steps, truncated };
}

const LEVELS: readonly string[] = ['http', 'accessibility', 'vision', 'terminal', 'skipped', 'not_run'];
const STATUSES: readonly string[] = ['ok', 'failed', 'skipped', 'not_run', 'blocked', 'drifted'];

/** A trace read from an untrusted object (the container result): valid steps only, at most 200. */
export function sanitizeTrace(value: unknown): TraceStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TraceStep[] = [];
  for (const raw of value) {
    if (out.length >= TRACE_MAX_STEPS) break;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const s = raw as Record<string, unknown>;
    if (!Number.isInteger(s.index) || (s.index as number) < 0) continue;
    if (typeof s.label !== 'string' || typeof s.level !== 'string' || !LEVELS.includes(s.level)) continue;
    if (typeof s.status !== 'string' || !STATUSES.includes(s.status)) continue;
    if (typeof s.durationMs !== 'number' || !Number.isFinite(s.durationMs) || s.durationMs < 0) continue;
    if (s.note !== undefined && typeof s.note !== 'string') continue;
    const step: TraceStep = {
      index: s.index as number,
      label: scrub(s.label, [], TRACE_LABEL_MAX),
      level: s.level as TraceLevel,
      durationMs: Math.floor(s.durationMs),
      status: s.status as TraceStatus,
    };
    if (typeof s.note === 'string') step.note = scrub(s.note, [], TRACE_LABEL_MAX);
    out.push(step);
  }
  return out;
}
