/**
 * Audit log: one JSON line per call of a generated tool, in `<App_Data_Dir>/audit/audit.jsonl`.
 * Standalone runtime module: imports only `node:*` and its siblings.
 *
 * No secret value ever reaches a line: sensitive argument names become `***`, declared secret names too, and every
 * known secret value (environment and vault) is removed from every text, which is also clipped to 200 characters.
 */
import { appendFile, mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const REDACTED = '***';
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 1_000;
const MIN_SECRET_LENGTH = 3;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;

/** Equal to SENSITIVE_KEY of `src/studio/playground.ts` (a test compares the two sources). */
export const SENSITIVE_KEY: RegExp =
  /pass(word|wd|phrase|code)?|secret|token|(^|[^a-z])t?otp($|[^a-z])|api[-_ ]?key|credential|cvv|(^|[^a-z])pin($|[^a-z])|(^|[^a-z])ssn($|[^a-z])|private[-_ ]?key|authorization|cookie/i;

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY.test(name);
}

const keyForm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const usableSecrets = (values: readonly string[]): string[] =>
  [...new Set(values.filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // never cut a surrogate pair in half
  return `${text.slice(0, end)}\u2026`;
};

const removeSecrets = (text: string, secrets: readonly string[]): string => {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
};

/** Removes every secret value, then clips to `max` characters (default 200). */
export function scrubText(text: string, secretValues: readonly string[], max: number = AUDIT_TEXT_MAX): string {
  const source = typeof text === 'string' ? text : String(text);
  return clip(removeSecrets(source, usableSecrets(secretValues)), max);
}

/** The values held under sensitive or declared names, so the same value is also removed where it appears elsewhere. */
const sensitiveValuesIn = (args: unknown, names: ReadonlySet<string>): string[] => {
  const values: string[] = [];
  const walk = (node: unknown, sensitive: boolean, depth: number): void => {
    if (depth > MAX_DEPTH + 4) return;
    if (typeof node === 'string' || typeof node === 'number') {
      if (sensitive && String(node).length >= MIN_SECRET_LENGTH) values.push(String(node));
    } else if (Array.isArray(node)) node.forEach((item) => walk(item, sensitive, depth + 1));
    else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, sensitive || isSensitiveKey(k) || names.has(keyForm(k)), depth + 1);
    }
  };
  walk(args, false, 0);
  return values;
};

/** The values the arguments hold under sensitive or declared names (to be removed from every other text too). */
export function collectSensitiveValues(args: unknown, declared: readonly string[]): string[] {
  return sensitiveValuesIn(args, new Set(declared.map(keyForm)));
}

/**
 * A copy of the arguments that is safe to show and to store: values under sensitive or declared names become `***`,
 * known secret values are removed from every text, every text is at most 200 characters, and the result is plain JSON.
 */
export function redactArguments(args: unknown, declared: readonly string[], secretValues: readonly string[]): unknown {
  const names = new Set(declared.map(keyForm));
  const secrets = usableSecrets([...secretValues, ...sensitiveValuesIn(args, names)]);
  const text = (s: string): string => clip(removeSecrets(s, secrets), AUDIT_TEXT_MAX);
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return text(node);
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (typeof node === 'boolean' || node === null) return node;
    if (node === undefined || typeof node === 'function' || typeof node === 'symbol') return null;
    if (typeof node === 'bigint') return text(node.toString());
    if (depth >= MAX_DEPTH) return '[\u2026]';
    if (Array.isArray(node)) return node.slice(0, MAX_ITEMS).map((item) => walk(item, depth + 1));
    if (typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>).slice(0, MAX_ITEMS)) {
        out[text(k)] = isSensitiveKey(k) || names.has(keyForm(k)) ? REDACTED : walk(v, depth + 1);
      }
      return out;
    }
    return null;
  };
  return walk(args, 0);
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** One line, at most 16384 bytes, `steps` trimmed to fit. */
export function formatAuditLine(entry: AuditEntry): string {
  let line = JSON.stringify(entry);
  if (byteLength(line) <= AUDIT_MAX_LINE_BYTES) return line;
  const steps = entry.steps ?? [];
  let keep = steps.length;
  while (keep > 0) {
    keep = Math.floor(keep / 2);
    const trimmed: AuditEntry = { ...entry, stepsTruncated: true };
    if (keep > 0) trimmed.steps = steps.slice(0, keep);
    else delete trimmed.steps;
    line = JSON.stringify(trimmed);
    if (byteLength(line) <= AUDIT_MAX_LINE_BYTES) return line;
  }
  const bare: AuditEntry = { ...entry, arguments: { truncated: true } };
  delete bare.steps;
  if (entry.steps !== undefined) bare.stepsTruncated = true;
  line = JSON.stringify(bare);
  if (byteLength(line) <= AUDIT_MAX_LINE_BYTES) return line;
  return JSON.stringify({ ...bare, tool: clip(bare.tool, 80), application: clip(bare.application, 200), outcome: clip(bare.outcome, AUDIT_TEXT_MAX) });
}

const RISK_VALUES: readonly string[] = ['read', 'write', 'delete'];
const SOURCE_VALUES: readonly string[] = ['kiro', 'studio'];
const DECISION_VALUES: readonly string[] = ['auto', 'approved', 'denied', 'timeout', 'unavailable'];
const LEVELS: readonly string[] = ['http', 'accessibility', 'vision', 'terminal', 'skipped', 'not_run'];
const STATUSES: readonly string[] = ['ok', 'failed', 'skipped', 'not_run', 'blocked', 'drifted'];

const parseStep = (value: unknown): TraceStep | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  if (!Number.isInteger(s.index) || (s.index as number) < 0) return undefined;
  if (typeof s.label !== 'string' || typeof s.level !== 'string' || !LEVELS.includes(s.level)) return undefined;
  if (typeof s.durationMs !== 'number' || !Number.isFinite(s.durationMs) || s.durationMs < 0) return undefined;
  if (typeof s.status !== 'string' || !STATUSES.includes(s.status)) return undefined;
  if (s.note !== undefined && typeof s.note !== 'string') return undefined;
  const step: TraceStep = { index: s.index as number, label: s.label, level: s.level as TraceStep['level'], durationMs: s.durationMs, status: s.status as TraceStep['status'] };
  if (s.note !== undefined) step.note = s.note as string;
  return step;
};

/** Strict shape, undefined when corrupt. */
export function parseAuditLine(line: string): AuditEntry | undefined {
  try {
    if (typeof line !== 'string' || line.trim() === '' || byteLength(line) > AUDIT_MAX_LINE_BYTES) return undefined;
    const o = JSON.parse(line) as unknown;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const e = o as Record<string, unknown>;
    if (e.v !== 1) return undefined;
    if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return undefined;
    if (typeof e.tool !== 'string' || typeof e.application !== 'string') return undefined;
    if (typeof e.risk !== 'string' || !RISK_VALUES.includes(e.risk)) return undefined;
    if (typeof e.source !== 'string' || !SOURCE_VALUES.includes(e.source)) return undefined;
    if (!('arguments' in e)) return undefined;
    if (typeof e.decision !== 'string' || !DECISION_VALUES.includes(e.decision)) return undefined;
    if (typeof e.outcome !== 'string') return undefined;
    if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0) return undefined;
    const entry: AuditEntry = {
      v: 1,
      at: e.at,
      tool: e.tool,
      application: e.application,
      risk: e.risk as AuditEntry['risk'],
      source: e.source as AuditSource,
      arguments: e.arguments,
      decision: e.decision as AuditDecision,
      outcome: e.outcome,
      durationMs: e.durationMs,
    };
    if (e.steps !== undefined) {
      if (!Array.isArray(e.steps)) return undefined;
      const steps: TraceStep[] = [];
      for (const raw of e.steps) {
        const step = parseStep(raw);
        if (step === undefined) return undefined;
        steps.push(step);
      }
      entry.steps = steps;
    }
    if (e.stepsTruncated !== undefined) {
      if (e.stepsTruncated !== true) return undefined;
      entry.stepsTruncated = true;
    }
    return entry;
  } catch {
    return undefined;
  }
}

/** Oldest whole lines removed until both limits hold; the rest unchanged and in order. */
export function applyRetention(lines: readonly string[], limits: { maxEntries: number; maxBytes: number } = { maxEntries: AUDIT_MAX_ENTRIES, maxBytes: AUDIT_MAX_BYTES }): string[] {
  let start = 0;
  let bytes = 0;
  for (const line of lines) bytes += byteLength(line) + 1;
  while (start < lines.length && (lines.length - start > limits.maxEntries || bytes > limits.maxBytes)) {
    bytes -= byteLength(lines[start]) + 1;
    start += 1;
  }
  return lines.slice(start);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

const acquireLock = async (lockDir: string, now: () => number): Promise<boolean> => {
  const started = now();
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await mkdir(lockDir);
      return true;
    } catch (e) {
      // Windows answers EPERM or EBUSY while another process is removing the folder: wait and try again.
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(errCode(e) ?? '')) return false;
      try {
        const info = await stat(lockDir);
        if (now() - info.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lockDir).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // released between the two calls
      }
    }
    if (now() - started > LOCK_WAIT_MS) return false;
    await sleep(2 + Math.floor(Math.random() * 10));
  }
  return false;
};

const releaseLock = async (lockDir: string): Promise<void> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rmdir(lockDir);
      return;
    } catch (e) {
      if (errCode(e) === 'ENOENT') return;
      await sleep(5 * (attempt + 1));
    }
  }
};

const splitLines = (text: string): string[] => text.split('\n').filter((l) => l !== '');

export async function appendAudit(dataDir: string, entry: AuditEntry, now: () => number = Date.now): Promise<'ok' | 'dropped'> {
  const dir = join(dataDir, 'audit');
  const file = join(dir, 'audit.jsonl');
  const lockDir = join(dir, 'audit.lock');
  let locked = false;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    locked = await acquireLock(lockDir, now);
    if (!locked) throw new Error('lock');
    const line = formatAuditLine(entry);
    let existing: string[] = [];
    let endsClean = true;
    try {
      const text = await readFile(file, 'utf8');
      existing = splitLines(text);
      endsClean = text === '' || text.endsWith('\n');
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
    const all = [...existing, line];
    const kept = applyRetention(all);
    if (kept.length === all.length && endsClean) {
      await appendFile(file, `${line}\n`, { mode: 0o600 });
    } else {
      const tmp = `${file}.tmp-${process.pid}`;
      await writeFile(tmp, `${kept.join('\n')}\n`, { mode: 0o600 });
      await rename(tmp, file);
    }
    return 'ok';
  } catch {
    process.stderr.write('daemonize: an audit entry could not be written and was dropped\n');
    return 'dropped';
  } finally {
    if (locked) await releaseLock(lockDir);
  }
}

/** Newest first, skips corrupt lines. */
export async function readAuditEntries(dataDir: string, options: { limit?: number } = {}): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  const lines = splitLines(text);
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit >= 0 ? Math.floor(options.limit) : Infinity;
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = parseAuditLine(lines[i]);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}
