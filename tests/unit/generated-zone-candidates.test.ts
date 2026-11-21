/**
 * G-D: the generator embeds candidate selectors and reports a zone fallback only for a set whose zone has `selectors`
 * (Requirements 6.7, 7.3, 7.4).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpGenerator, usesZoneCandidates, withZoneCandidates } from '../../src/compiler/mcp-generator.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import type { WorkflowSet } from '../../src/types.js';

const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures', 'regression');
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const stripFw = (text: string): string => lf(text).split('\n').filter((line) => !line.trimEnd().endsWith('//#fw')).join('\n');
const load = (file: string): WorkflowSet => deserializeWorkflowSet(readFileSync(join(FIXTURES, file), 'utf-8'));
const SNAPSHOT = (name: string): string => lf(readFileSync(join(FIXTURES, 'snapshot', name), 'utf-8'));

export const ZONE = {
  selector: '#total',
  selectors: ['#total', '[data-testid="total"]', 'body > div:nth-of-type(2)'],
  extractor: { kind: 'text' },
  fingerprint: { tag: 'div', kind: 'text' },
};

function withZone(set: WorkflowSet, zone: Record<string, unknown>): WorkflowSet {
  const copy = structuredClone(set);
  copy.workflows[0].resultZone = zone as never;
  return copy;
}

const names = (set: WorkflowSet): Map<string, string> => new Map(set.workflows.map((w, i) => [w.id, `tool_${i}`]));

describe('generated code and zone candidates', () => {
  const generator = new McpGenerator();

  it('emits nothing new for a set without selectors', () => {
    const set = load('pre-change.workflows.json');
    expect(usesZoneCandidates(set)).toBe(false);
    expect(stripFw(generator.generateReplay(set))).toBe(SNAPSHOT('web.default.replay.ts.txt'));
    expect(stripFw(generator.generateDockerReplay(set, 'daemonize-sandbox:latest'))).toBe(
      stripFw(generator.generateDockerReplay(withZone(set, { selector: '#total', extractor: { kind: 'text' } }), 'daemonize-sandbox:latest'))
    );
  });

  it('embeds selectors and fingerprint in final and adds the fallback lines for a set with selectors', () => {
    const set = withZone(load('pre-change.workflows.json'), ZONE);
    expect(usesZoneCandidates(set)).toBe(true);
    const server = generator.generate(set, names(set));
    expect(server).toContain(JSON.stringify(ZONE.selectors));
    expect(server).toContain(JSON.stringify(ZONE.fingerprint));
    const replay = generator.generateReplay(set);
    expect(replay).toContain('selectors?: string[]; fingerprint?: { tag: string; kind: string; count?: number }');
    expect(replay).toContain('let fallback: { position: number; of: number } | undefined;');
    expect(replay).toContain('fallback = read.fallback;');
    expect(replay).toContain('zoneFallback: fallback');
  });

  it('leaves a terminal set unchanged', () => {
    const set = load('pre-change-tui.workflows.json');
    expect(stripFw(generator.generateReplay(set))).toBe(SNAPSHOT('tui.default.replay.ts.txt'));
  });

  it('throws when an anchor line is missing', () => {
    const lines = generator.generateReplay(withZone(load('pre-change.workflows.json'), ZONE)).split('\n');
    const plain = generator.generateReplay(load('pre-change.workflows.json')).split('\n');
    expect(() => withZoneCandidates(plain)).not.toThrow();
    for (const anchor of ['    text = read.text;', '  let data: unknown;', '    ...(final.resultZone === undefined ? {} : { data }),']) {
      expect(() => withZoneCandidates(plain.filter((line) => line !== anchor))).toThrow(/generated line not found/);
    }
    expect(lines.length).toBe(plain.length + 3);
  });
});
