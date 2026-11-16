// Feature: daemonize, Property 5: merge commutativity; Property 6: merge idempotence
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { StateMachineBuilder } from '../../src/state/state-machine-builder.js';
import type { StateGraph, Screen, Transition } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Arbitraries (same constraints as task 2.5)
// ---------------------------------------------------------------------------

/** Valid 16-char hex ScreenId */
const screenIdArb = fc.hexaString({ minLength: 16, maxLength: 16 });

/** Valid 64-char hex normalizedHash */
const normalizedHashArb = fc.hexaString({ minLength: 64, maxLength: 64 });

/** Valid ISO 8601 date-time string */
const isoDateArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
  .map((d) => d.toISOString());

/** Valid UUID */
const uuidArb = fc.uuid();

/** Screen node for a known ID */
const screenArb = (id: string): fc.Arbitrary<Screen> =>
  fc.record({
    id: fc.constant(id as any),
    type: fc.oneof(fc.constant('dom' as const), fc.constant('terminal' as const)),
    normalizedHash: normalizedHashArb,
    snapshot: fc.string({ minLength: 1, maxLength: 100 }),
    label: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    firstSeenAt: isoDateArb,
    observationCount: fc.integer({ min: 1, max: 10 }),
  });

/** Transition between existing screen IDs */
const transitionArb = (screenIds: string[]): fc.Arbitrary<Transition> =>
  fc.record({
    id: uuidArb,
    sourceScreenId: fc.oneof(...screenIds.map((id) => fc.constant(id as any))),
    destinationScreenId: fc.oneof(...screenIds.map((id) => fc.constant(id as any))),
    actionType: fc.oneof(
      fc.constant('click' as const),
      fc.constant('keypress' as const),
      fc.constant('form_submit' as const),
      fc.constant('type' as const),
      fc.constant('select' as const),
    ),
    label: fc.string({ minLength: 1, maxLength: 50 }),
    selector: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
    observedPayloads: fc.array(fc.record({ key: fc.string() }), { maxLength: 3 }),
  });

/** Full StateGraph with 1-5 screens and 0-5 transitions */
const stateGraphArb: fc.Arbitrary<StateGraph> = fc
  .array(screenIdArb, { minLength: 1, maxLength: 5 })
  .chain((ids) => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) uniqueIds.push('abcdef0123456789');
    return fc.record({
      version: fc.constant('1' as const),
      createdAt: isoDateArb,
      updatedAt: isoDateArb,
      screens: fc.record(
        Object.fromEntries(uniqueIds.map((id) => [id, screenArb(id)])) as any,
      ),
      transitions: fc.array(transitionArb(uniqueIds), { minLength: 0, maxLength: 5 }),
    });
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh StateMachineBuilder seeded with the given graph, then merge
 * `other` into it, and return the resulting StateGraph.
 */
function mergeGraphs(base: StateGraph, other: StateGraph): StateGraph {
  const builder = new StateMachineBuilder();
  (builder as any).graph = structuredClone(base);
  return builder.merge(structuredClone(other));
}

/**
 * Compute the deduplication composite key for a transition, matching the
 * key used by StateMachineBuilder.merge.
 * Key: sourceScreenId | actionType | (selector ?? '') | | destinationScreenId
 */
function tKey(t: Transition): string {
  return `${t.sourceScreenId}|${t.actionType}|${t.selector ?? ''}||${t.destinationScreenId}`;
}

// ---------------------------------------------------------------------------
// Property 5: Merge Commutativity
// ---------------------------------------------------------------------------

describe('StateMachineBuilder — Property 5: Merge Commutativity', () => {
  /**
   * Validates: Requirements 10.4
   *
   * For any two valid StateGraphs A and B:
   *   merge(A, B) and merge(B, A) must have the same screen-ID set and the
   *   same set of unique-by-key transitions (same count and same composite
   *   key set).
   *
   * Commutativity is checked by composite key (sourceScreenId + actionType +
   * selector + destinationScreenId) rather than by transition ID, because the
   * merge algorithm deduplicates by that key — two transitions with the same
   * key but different IDs (possible in a hand-crafted or shrunk graph) will
   * be collapsed to one.
   */
  it('merge(A, B) and merge(B, A) have the same screen set and contain all original transitions', () => {
    fc.assert(
      fc.property(stateGraphArb, stateGraphArb, (graphA, graphB) => {
        const mergedAB = mergeGraphs(graphA, graphB);
        const mergedBA = mergeGraphs(graphB, graphA);

        // 1. Screen ID sets must be identical
        const screensAB = Object.keys(mergedAB.screens).sort();
        const screensBA = Object.keys(mergedBA.screens).sort();
        if (screensAB.join(',') !== screensBA.join(',')) return false;

        // 2. Transition composite-key sets must be identical
        const keysAB = new Set(mergedAB.transitions.map(tKey));
        const keysBA = new Set(mergedBA.transitions.map(tKey));
        if (keysAB.size !== keysBA.size) return false;
        for (const k of keysAB) {
          if (!keysBA.has(k)) return false;
        }

        // 3. All unique-by-key transitions from A must appear in both results
        const uniqueKeysA = new Set(graphA.transitions.map(tKey));
        for (const k of uniqueKeysA) {
          if (!keysAB.has(k) || !keysBA.has(k)) return false;
        }

        // 4. All unique-by-key transitions from B must appear in both results
        const uniqueKeysB = new Set(graphB.transitions.map(tKey));
        for (const k of uniqueKeysB) {
          if (!keysAB.has(k) || !keysBA.has(k)) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Merge Idempotence
// ---------------------------------------------------------------------------

describe('StateMachineBuilder — Property 6: Merge Idempotence', () => {
  /**
   * Validates: Requirements 10.5
   *
   * For any valid StateGraph A:
   *   merge(A, A) must equal A in terms of unique-by-key transitions — the
   *   same set of unique composite keys (sourceScreenId + actionType + selector
   *   + destinationScreenId) must appear in the merged result, with no
   *   additions or losses.
   *
   * We compare by composite key set rather than transition count or ID, because
   * the merge algorithm deduplicates by that key. A graph with internally
   * duplicate-keyed transitions will be normalised to one copy per key; that
   * normalised form is then idempotent under further merges with itself.
   */
  it('merge(A, A) equals A in screen set and transition set', () => {
    fc.assert(
      fc.property(stateGraphArb, (graph) => {
        const merged = mergeGraphs(graph, graph);

        // 1. Screen sets must be identical
        const origScreenIds = Object.keys(graph.screens).sort();
        const mergedScreenIds = Object.keys(merged.screens).sort();
        if (origScreenIds.join(',') !== mergedScreenIds.join(',')) return false;

        // 2. Composite-key sets must be identical (merge(A,A) = deduplicated A)
        const origKeys = new Set(graph.transitions.map(tKey));
        const mergedKeys = new Set(merged.transitions.map(tKey));
        if (origKeys.size !== mergedKeys.size) return false;
        for (const k of origKeys) {
          if (!mergedKeys.has(k)) return false;
        }

        return true;
      }),
      { numRuns: 100 },
    );
  });
});
