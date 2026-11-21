import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_MAX_ENTRIES,
  appendAudit,
  applyRetention,
  formatAuditLine,
  parseAuditLine,
  readAuditEntries,
  redactArguments,
  scrubText,
} from '../../src/replay/runtime/audit-log.js';
import type { AuditEntry } from '../../src/replay/runtime/audit-log.js';
import { createFirewall } from '../../src/replay/runtime/firewall.js';

// Planted fake values: built at run time, never a real credential.
const FAKE_ENV_SECRET = ['fake', 'env', 'secret', 'value', '42'].join('-');
const FAKE_PASSWORD = ['fake', 'pw', 'value', '17'].join('-');
const FAKE_VAULT_SECRET = ['fake', 'vault', 'secret', '99'].join('-');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dmz-audit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (n: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  v: 1,
  at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  tool: 'create_invoice',
  application: 'https://app.example.com',
  risk: 'write',
  source: 'kiro',
  arguments: { n },
  decision: 'approved',
  outcome: 'success',
  durationMs: n,
  ...extra,
});

describe('audit log: no secret value is stored or shown', () => {
  it('redacts sensitive names, declared names and known secret values', () => {
    const args = {
      customer: `Ada ${FAKE_ENV_SECRET} Lovelace`,
      password: FAKE_PASSWORD,
      api_key: FAKE_PASSWORD,
      nested: { token: FAKE_PASSWORD, note: `uses ${FAKE_PASSWORD}`, list: [FAKE_VAULT_SECRET, 'ok'] },
      customField: 'declared-value-123',
    };
    const out = redactArguments(args, ['customField'], [FAKE_ENV_SECRET, FAKE_VAULT_SECRET]);
    const text = JSON.stringify(out);
    for (const secret of [FAKE_ENV_SECRET, FAKE_PASSWORD, FAKE_VAULT_SECRET, 'declared-value-123']) expect(text).not.toContain(secret);
    expect(out).toMatchObject({ password: '***', api_key: '***', customField: '***', nested: { token: '***' } });
  });

  it('clips every text to 200 characters', () => {
    const out = redactArguments({ a: 'x'.repeat(5000), ['k'.repeat(900)]: 'v', b: ['y'.repeat(999)] }, [], []) as Record<string, unknown>;
    const walk = (n: unknown): void => {
      if (typeof n === 'string') expect(n.length).toBeLessThanOrEqual(200);
      else if (Array.isArray(n)) n.forEach(walk);
      else if (n !== null && typeof n === 'object') Object.entries(n).forEach(([k, v]) => (walk(k), walk(v)));
    };
    walk(out);
    expect(scrubText('z'.repeat(1000), [], 120).length).toBe(120);
  });

  it('a call through the firewall writes no secret value to the log', async () => {
    const config = {
      application: 'https://app.example.com',
      targetType: 'web' as const,
      tools: {
        pay: { risk: 'write' as const, writeSteps: [], sensitiveArgs: ['card'], secretVariables: ['DAEMONIZE_SECRET_API'], steps: [{ label: `Type ${FAKE_ENV_SECRET}`, actionType: 'type' }] },
      },
    };
    const env = { DAEMONIZE_DATA_DIR: dir, DAEMONIZE_SECRET_API: FAKE_ENV_SECRET, DAEMONIZE_TRACE: '1' } as NodeJS.ProcessEnv;
    const leaking = async () => ({
      content: [{ type: 'text', text: JSON.stringify({ success: false, error: `failed with ${FAKE_ENV_SECRET} and ${FAKE_PASSWORD}`, elapsedMs: 5 }) }],
      isError: true,
    });
    await createFirewall(config, (r) => r, env).wrap('pay', leaking, () => null)({ card: FAKE_PASSWORD, memo: `see ${FAKE_ENV_SECRET}` });
    const file = await readFile(join(dir, 'audit', 'audit.jsonl'), 'utf8');
    for (const secret of [FAKE_ENV_SECRET, FAKE_PASSWORD]) expect(file).not.toContain(secret);
    const entries = await readAuditEntries(dir);
    expect(JSON.stringify(entries)).not.toContain(FAKE_ENV_SECRET);
    expect(entries[0].outcome.length).toBeLessThanOrEqual(200);
  });
});

describe('audit log: file behaviour', () => {
  it('keeps the last 1000 entries', async () => {
    const lines = Array.from({ length: AUDIT_MAX_ENTRIES + 5 }, (_, i) => formatAuditLine(entry(i)));
    const kept = applyRetention(lines);
    expect(kept).toHaveLength(AUDIT_MAX_ENTRIES);
    expect(kept[kept.length - 1]).toBe(lines[lines.length - 1]);
    expect(kept[0]).toBe(lines[5]);
  });

  it('keeps at most 1 MiB, dropping the oldest lines', () => {
    const big = (i: number): string => formatAuditLine(entry(i, { outcome: 'o'.repeat(200), arguments: { text: 'a'.repeat(190), i, pad: 'b'.repeat(190) } }));
    const lines = Array.from({ length: 900 }, (_, i) => big(i));
    const kept = applyRetention(lines, { maxEntries: 1000, maxBytes: 100_000 });
    const bytes = kept.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(100_000);
    expect(kept).toEqual(lines.slice(lines.length - kept.length));
    expect(kept.length).toBeGreaterThan(0);
  });

  it('appends, reads newest first and skips corrupt lines', async () => {
    await appendAudit(dir, entry(1));
    await writeFile(join(dir, 'audit', 'audit.jsonl'), `${formatAuditLine(entry(1))}\n{"half":\nnot json\n`, 'utf8');
    await appendAudit(dir, entry(2));
    const read = await readAuditEntries(dir);
    expect(read.map((e) => e.durationMs)).toEqual([2, 1]);
    expect(await readAuditEntries(dir, { limit: 1 })).toHaveLength(1);
    expect(parseAuditLine('{"v":1}')).toBeUndefined();
  });

  it('a missing file reads as no entries', async () => {
    expect(await readAuditEntries(join(dir, 'nothing'))).toEqual([]);
  });

  it('concurrent appends never interleave', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => appendAudit(dir, entry(i, { arguments: { text: 'q'.repeat(150) } }))));
    expect(results.every((r) => r === 'ok')).toBe(true);
    const text = await readFile(join(dir, 'audit', 'audit.jsonl'), 'utf8');
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(30);
    expect(lines.every((l) => parseAuditLine(l) !== undefined)).toBe(true);
  });

  it('drops the entry with one stderr line when the lock cannot be had', async () => {
    await mkdir(join(dir, 'audit', 'audit.lock'), { recursive: true });
    const result = await appendAudit(dir, entry(1));
    expect(result).toBe('dropped');
  }, 15_000);

  it('a line stays under 16384 bytes by trimming steps only', () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({ index: i, label: 'L'.repeat(120), level: 'http' as const, durationMs: i, status: 'ok' as const, note: 'N'.repeat(120) }));
    const line = formatAuditLine(entry(1, { steps }));
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16_384);
    const parsed = parseAuditLine(line)!;
    expect(parsed.stepsTruncated).toBe(true);
    expect(parsed.steps!.length).toBeLessThan(200);
    expect(parsed.arguments).toEqual({ n: 1 });
  });
});
