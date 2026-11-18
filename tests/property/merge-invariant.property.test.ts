// Feature: user-journey-improvements, Property 20: Merging keeps earlier workflows
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeWorkflowSets } from '../../src/workflow/merge.js';
import { startUrlOf, storageStateOf } from '../../src/workflow/workflow-scope.js';
import { workflowSetPairArb } from '../helpers/workflow-arbitraries.js';

describe('Property 20: Merging keeps earlier workflows', () => {
  it('keeps unreplaced base workflows, their order, their start page and login', () => {
    // **Validates: Requirements 11.1, 11.2, 11.8, 11.9, 11.10, 11.12**
    fc.assert(
      fc.property(workflowSetPairArb, fc.boolean(), ({ base, newer }, dropBaseTarget) => {
        if (dropBaseTarget) {
          delete base.storageState;
        }
        const baseCopy = structuredClone(base);
        const newerCopy = structuredClone(newer);
        const merged = mergeWorkflowSets(base, newer);

        expect(base).toEqual(baseCopy);
        expect(newer).toEqual(newerCopy);

        const replaced = new Set(newer.workflows.map((w) => w.id));
        const survivors = base.workflows.filter((w) => !replaced.has(w.id));
        const keepsBase = survivors.length > 0;

        // order: replaced stays at its base position, new ones appended
        const expectedIds = [...base.workflows.map((w) => w.id), ...newer.workflows.filter((w) => !base.workflows.some((b) => b.id === w.id)).map((w) => w.id)];
        expect(merged.workflows.map((w) => w.id)).toEqual(expectedIds);
        for (const w of newer.workflows) expect(merged.workflows.find((m) => m.id === w.id)).toEqual(w);
        for (const w of survivors) expect(merged.workflows.find((m) => m.id === w.id)).toEqual(w);

        const source = keepsBase ? base : newer;
        expect(merged.targetName).toBe(source.targetName);
        expect(merged.startUrl).toBe(source.startUrl);
        expect('startUrl' in merged).toBe('startUrl' in source);
        expect(merged.storageState).toBe(source.storageState);
        expect('storageState' in merged).toBe('storageState' in source);

        for (const w of survivors) {
          const after = merged.workflows.find((m) => m.id === w.id)!;
          expect(startUrlOf(merged, after)).toBe(startUrlOf(base, w));
          expect(storageStateOf(merged, after)).toBe(storageStateOf(base, w));
        }
      }),
      { numRuns: 200 },
    );
  });
});
