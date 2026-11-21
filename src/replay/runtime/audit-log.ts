/**
 * Audit log: one JSON line per call of a generated tool, in `<App_Data_Dir>/audit/audit.jsonl`.
 * Standalone runtime module: imports only `node:*` and its siblings.
 *
 * G0 seam: types, constants and signatures are final; the function bodies belong to group G-B.
 */
import type { TraceStep } from './trace.js';

export type AuditDecision = 'auto' | 'approved' | 'denied' | 'timeout' | 'unavailable';
export type AuditSource = 'kiro' | 'studio';
export interface AuditEntry {
  v: 1;
  /** ISO 8601 UTC. */
  at: string;
  tool: string;
  application: string;
  risk: 'read' | 'write' | 'delete';
  source: AuditSource;
  /** Redacted_Arguments. */
  arguments: unknown;
  decision: AuditDecision;
  /** 'success' or an error code or clipped text (200). */
  outcome: string;
  durationMs: number;
  /** Compact, no pictures, no typed values. */
  steps?: TraceStep[];
  stepsTruncated?: true;
}

export const AUDIT_MAX_ENTRIES = 1000;
export const AUDIT_MAX_BYTES = 1_048_576;
export const AUDIT_MAX_LINE_BYTES = 16_384;
export const AUDIT_TEXT_MAX = 200;
/** Equal to SENSITIVE_KEY of `src/studio/playground.ts` (a test compares the two sources). */
export const SENSITIVE_KEY: RegExp =
  /pass(word|wd|phrase|code)?|secret|token|(^|[^a-z])t?otp($|[^a-z])|api[-_ ]?key|credential|cvv|(^|[^a-z])pin($|[^a-z])|(^|[^a-z])ssn($|[^a-z])|private[-_ ]?key|authorization|cookie/i;

export function isSensitiveKey(_name: string): boolean {
  throw new Error('not implemented: G-B');
}
export function redactArguments(_args: unknown, _declared: readonly string[], _secretValues: readonly string[]): unknown {
  throw new Error('not implemented: G-B');
}
export function scrubText(_text: string, _secretValues: readonly string[], _max?: number): string {
  throw new Error('not implemented: G-B');
}
/** One line, at most 16384 bytes, `steps` trimmed to fit. */
export function formatAuditLine(_entry: AuditEntry): string {
  throw new Error('not implemented: G-B');
}
/** Strict shape, undefined when corrupt. */
export function parseAuditLine(_line: string): AuditEntry | undefined {
  throw new Error('not implemented: G-B');
}
/** Oldest whole lines removed until both limits hold; the rest unchanged and in order. */
export function applyRetention(_lines: readonly string[], _limits?: { maxEntries: number; maxBytes: number }): string[] {
  throw new Error('not implemented: G-B');
}
export function appendAudit(_dataDir: string, _entry: AuditEntry, _now?: () => number): Promise<'ok' | 'dropped'> {
  throw new Error('not implemented: G-B');
}
/** Newest first, skips corrupt lines. */
export function readAuditEntries(_dataDir: string, _options?: { limit?: number }): Promise<AuditEntry[]> {
  throw new Error('not implemented: G-B');
}
