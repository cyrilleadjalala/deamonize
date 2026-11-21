import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

// Real files and real timers: allow a loaded machine more than the default 30 s.
vi.setConfig({ testTimeout: 180_000 });
import {
  AUDIT_MAX_ENTRIES,
  AUDIT_MAX_LINE_BYTES,
  appendAudit,
  applyRetention,
  formatAuditLine,
  isSensitiveKey,
  parseAuditLine,
  readAuditEntries,
  redactArguments,
  scrubText,
} from '../../src/replay/runtime/audit-log.js';
import type { AuditEntry } from '../../src/replay/runtime/audit-log.js';
import { buildTrace } from '../../src/replay/runtime/trace.js';
import { anyText, argumentsWithSensitiveNames, auditEntry, secretLikeString, workflowSteps } from '../helpers/firewall-arbitraries.js';

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'dmz-ap-'));

const stringsOf = (node: unknown, out: string[] = []): string[] => {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => stringsOf(n, out));
  else if (node !== null && typeof node === 'object') for (const [k, v] of Object.entries(node)) (out.push(k), stringsOf(v, out));
  return out;
};
/** Every value that sits under a sensitive name in the input. */
const sensitiveValuesOf = (node: unknown, under = false, out: string[] = []): string[] => {
  if (typeof node === 'string') {
    if (under) out.push(node);
  } else if (Array.isArray(node)) node.forEach((n) => sensitiveValuesOf(n, under, out));
  else if (node !== null && typeof node === 'object') for (const [k, v] of Object.entries(node)) sensitiveValuesOf(v, under || isSensitiveKey(k), out);
  return out;
};

describe('audit log properties', () => {
  // Feature: kiro-native-agent-and-firewall, Property 19: Shown text holds no secret and is bounded
  it('Property 19: shown text holds no secret and is bounded', () => {
    /** **Validates: Requirements 13.1, 13.2, 13.14, 15.6, 15.13, 22.9** */
    fc.assert(
      fc.property(
        argumentsWithSensitiveNames,
        fc.array(secretLikeString, { maxLength: 3 }),
        anyText,
        fc.constantFrom('free', 'declared_field'),
        workflowSteps,
        (baseArgs, secrets, text, plantedName, steps) => {
          const args = { ...baseArgs, [plantedName]: `${text} ${secrets[0] ?? ''} ${text}`, listed: [secrets[1] ?? 'x', { deep: secrets[2] ?? 'y' }] };
          const out = redactArguments(args, ['declared_field'], secrets);
          const serialized = JSON.stringify(out);
          expect(() => JSON.parse(serialized)).not.toThrow();
          for (const secret of [...secrets, ...sensitiveValuesOf(args)]) expect(serialized.includes(secret)).toBe(false);
          for (const s of stringsOf(out)) expect(s.length).toBeLessThanOrEqual(200);
          expect((out as Record<string, unknown>).declared_field === undefined || (out as Record<string, unknown>).declared_field === '***').toBe(true);
          // labels and notes of a trace
          const labelled = steps.map((s, i) => ({ ...s, label: `${s.label ?? ''} ${secrets[i % Math.max(1, secrets.length)] ?? ''} ${text}` }));
          const trace = buildTrace({ steps: labelled, marks: { startedAt: 0, marks: [] }, result: { success: true }, targetType: 'web', secrets });
          for (const step of trace.steps) {
            for (const secret of secrets) expect(`${step.label}${step.note ?? ''}`.includes(secret)).toBe(false);
            expect(step.label.length).toBeLessThanOrEqual(120);
            expect((step.note ?? '').length).toBeLessThanOrEqual(120);
          }
          const scrubbed = scrubText(text, secrets);
          expect(scrubbed.length).toBeLessThanOrEqual(200);
          for (const secret of secrets) expect(scrubbed.includes(secret)).toBe(false);
        }
      ),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 20: An Audit_Entry round trips and fits one line
  it('Property 20: an Audit_Entry round trips and fits one line', async () => {
    /** **Validates: Requirements 15.2, 15.5, 15.12** */
    const garbage = fc.oneof(fc.string({ maxLength: 80 }).map((s) => s.replace(/\n/g, ' ')), fc.constant('{"v":1,"at":'), fc.constant('[]'));
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(auditEntry.map((e) => json(e) as AuditEntry), fc.boolean(), garbage), { maxLength: 6 }), async (items) => {
        const lines: string[] = [];
        const valid: AuditEntry[] = [];
        for (const [entry, corruptAfter, junk] of items) {
          const line = formatAuditLine(entry);
          expect(line.includes('\n')).toBe(false);
          expect(Buffer.byteLength(line)).toBeLessThanOrEqual(AUDIT_MAX_LINE_BYTES);
          const parsed = parseAuditLine(line);
          expect(parsed).toBeDefined();
          if (JSON.stringify(entry).length <= AUDIT_MAX_LINE_BYTES / 2) expect(parsed).toEqual(entry);
          lines.push(line);
          valid.push(parsed as AuditEntry);
          if (corruptAfter) lines.push(junk.trim() === '' ? 'x' : junk.startsWith('{') ? junk : `#${junk}`);
          if (corruptAfter) lines.push(line.slice(0, Math.max(1, line.length - 1)));
        }
        const dir = await tmp();
        try {
          await mkdir(join(dir, 'audit'), { recursive: true });
          await writeFile(join(dir, 'audit', 'audit.jsonl'), lines.length === 0 ? '' : `${lines.join('\n')}\n`);
          expect(await readAuditEntries(dir)).toEqual([...valid].reverse());
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-native-agent-and-firewall, Property 21: Retention keeps a suffix
  it('Property 21: retention keeps a suffix', () => {
    /** **Validates: Requirements 15.7, 15.14** */
    fc.assert(
      fc.property(fc.array(auditEntry, { minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1_000, max: 60_000 }), (entries, maxEntries, maxBytes) => {
        const lines = entries.map((e) => formatAuditLine(json(e) as AuditEntry));
        const kept = applyRetention(lines, { maxEntries, maxBytes });
        expect(kept.length).toBeLessThanOrEqual(maxEntries);
        expect(kept.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0)).toBeLessThanOrEqual(maxBytes);
        expect(kept).toEqual(lines.slice(lines.length - kept.length));
        if (kept.length > 0) expect(kept[kept.length - 1]).toBe(lines[lines.length - 1]);
        // nothing is dropped that fits
        if (kept.length < lines.length) {
          const withOneMore = lines.slice(lines.length - kept.length - 1);
          expect(withOneMore.length > maxEntries || withOneMore.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0) > maxBytes).toBe(true);
        }
      }),
      { numRuns: 150 }
    );
    const many = Array.from({ length: AUDIT_MAX_ENTRIES + 7 }, (_, i) => `{"i":${i}}`);
    expect(applyRetention(many)).toEqual(many.slice(7));
  });

  // Feature: kiro-native-agent-and-firewall, Property 22: Concurrent appends never interleave
  it('Property 22: concurrent appends never interleave', async () => {
    /** **Validates: Requirements 15.10** */
    await fc.assert(
      fc.asyncProperty(fc.array(auditEntry, { minLength: 2, maxLength: 10 }), async (entries) => {
        const dir = await tmp();
        try {
          const results = await Promise.all(entries.map((e) => appendAudit(dir, json(e) as AuditEntry)));
          expect(results.every((r) => r === 'ok')).toBe(true);
          const lines = (await readFile(join(dir, 'audit', 'audit.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');
          expect(lines).toHaveLength(entries.length);
          expect(lines.every((l) => parseAuditLine(l) !== undefined)).toBe(true);
          expect(lines.map((l) => (parseAuditLine(l) as AuditEntry).at).sort()).toEqual(entries.map((e) => e.at).sort());
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});
