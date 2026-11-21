import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpGenerator } from '../../src/compiler/mcp-generator.js';
import { deserializeWorkflowSet } from '../../src/workflow/workflow-set.js';
import { webZone } from '../helpers/zone-arbitraries.js';

const FIXTURES = resolve(import.meta.dirname, '..', 'fixtures', 'regression');
const BASE = readFileSync(join(FIXTURES, 'pre-change.workflows.json'), 'utf-8');
const generator = new McpGenerator();

const TYPE_OLD = 'export type ResultZone = Zone & { extractor?: ExtractorLike };';
const TYPE_NEW = 'export type ResultZone = Zone & { extractor?: ExtractorLike; selectors?: string[]; fingerprint?: { tag: string; kind: string; count?: number } };';
const INSERTED = new Set([
  '  let fallback: { position: number; of: number } | undefined;',
  '    fallback = read.fallback;',
  '    ...(fallback === undefined ? {} : { zoneFallback: fallback }),',
]);

function setWith(zone: unknown) {
  const set = deserializeWorkflowSet(BASE);
  set.workflows[0].resultZone = structuredClone(zone) as never;
  return set;
}

describe('generated zone candidates', () => {
  // Feature: result-zone-selector-robustness, Property 21: Generated text differs only by the named lines
  it('Property 21: Generated text differs only by the named lines', () => {
    // **Validates: Requirements 7.3, 7.4, 11.6**
    fc.assert(
      fc.property(webZone, (zone) => {
        const hasSelectors = zone.selectors !== undefined;
        const plainZone = { selector: zone.selector, extractor: zone.extractor };
        const withLines = generator.generateReplay(setWith(zone)).split('\n');
        const without = generator.generateReplay(setWith(plainZone)).split('\n');
        if (!hasSelectors) {
          expect(withLines).toEqual(without);
          return;
        }
        const restored = withLines.filter((line) => !INSERTED.has(line)).map((line) => (line === TYPE_NEW ? TYPE_OLD : line));
        expect(restored).toEqual(without);
        const server = generator.generate(setWith(zone), new Map([[setWith(zone).workflows[0].id, 'tool']]));
        expect(server).toContain(JSON.stringify(zone.selectors));
        expect(server).toContain(JSON.stringify(zone.fingerprint));
      }),
      { numRuns: 100 }
    );
  });
});
