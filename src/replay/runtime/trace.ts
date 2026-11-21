/**
 * Replay trace: which step ran, how long it took and how it ended.
 * Standalone runtime module: imports only `node:*` and its siblings. Copied next to the generated server
 * and into the container image.
 *
 * G0 seam: types, constants and signatures are final; the bodies belong to group G-B.
 */

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

/** No-op when no scope is active, so a replay used without the wrapper behaves as before. */
export function traceStep(_index: number): void {
  throw new Error('not implemented: G-B');
}

/** Runs `fn` in a scope (AsyncLocalStorage) and returns the marks it collected. */
export function traceScope<T>(_fn: () => Promise<T>): Promise<{ value: T; marks: TraceMarks }> {
  throw new Error('not implemented: G-B');
}

/** Container entry: the process serves one call, so the scope may last until exit. */
export function enterTraceScope(): void {
  throw new Error('not implemented: G-B');
}

export function takeMarks(): TraceMarks {
  throw new Error('not implemented: G-B');
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

export function buildTrace(_input: BuildTraceInput): { steps: TraceStep[]; truncated: boolean } {
  throw new Error('not implemented: G-B');
}

/** A trace read from an untrusted object (the container result): valid steps only, at most 200. */
export function sanitizeTrace(_value: unknown): TraceStep[] | undefined {
  throw new Error('not implemented: G-B');
}
