// Feature: daemonize, Property 1: State_Graph round-trip
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { StateMachineBuilder } from '../../src/state/state-machine-builder.js';
import type { StateGraph, Screen, Transition } from '../../src/types.js';

// Generate a valid 16-char hex ScreenId
const screenIdArb = fc.hexaString({ minLength: 16, maxLength: 16 });

// Generate a valid 64-char hex normalizedHash
const normalizedHashArb = fc.hexaString({ minLength: 64, maxLength: 64 });

// Generate a valid ISO 8601 date-time string
const isoDateArb = fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') })
  .map(d => d.toISOString());

// Generate a valid UUID
const uuidArb = fc.uuid();

// Generate a valid Screen
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

// Generate a valid Transition between two screen IDs
const transitionArb = (screenIds: string[]): fc.Arbitrary<Transition> =>
  fc.record({
    id: uuidArb,
    sourceScreenId: fc.oneof(...screenIds.map(id => fc.constant(id as any))),
    destinationScreenId: fc.oneof(...screenIds.map(id => fc.constant(id as any))),
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

// Generate a valid StateGraph with 1-5 screens and 0-5 transitions
const stateGraphArb: fc.Arbitrary<StateGraph> = fc.array(screenIdArb, { minLength: 1, maxLength: 5 })
  .chain(ids => {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) uniqueIds.push('abcdef0123456789');
    return fc.record({
      version: fc.constant('1' as const),
      createdAt: isoDateArb,
      updatedAt: isoDateArb,
      screens: fc.record(
        Object.fromEntries(uniqueIds.map(id => [id, screenArb(id)])) as any
      ),
      transitions: fc.array(transitionArb(uniqueIds), { minLength: 0, maxLength: 5 }),
    });
  });

describe('StateMachineBuilder — Property 1: State_Graph Serialization Round-Trip', () => {
  /**
   * Validates: Requirements 3.3
   *
   * For any valid StateGraph, serializing then deserializing produces a structurally
   * equal graph — same screen set, same transition set.
   */
  it('serialize then deserialize produces a structurally equal StateGraph', () => {
    fc.assert(
      fc.property(stateGraphArb, (graph) => {
        const builder = new StateMachineBuilder();
        // Inject the generated graph directly into the builder's private field
        (builder as any).graph = graph;

        const json = builder.serialize();
        const restored = StateMachineBuilder.deserialize(json);
        const restoredGraph = restored.getGraph();

        // Compare screen sets
        const origScreenIds = Object.keys(graph.screens).sort();
        const restoredScreenIds = Object.keys(restoredGraph.screens).sort();
        if (origScreenIds.join(',') !== restoredScreenIds.join(',')) return false;

        // Compare transition count and IDs
        const origTIds = graph.transitions.map(t => t.id).sort();
        const restoredTIds = restoredGraph.transitions.map(t => t.id).sort();
        if (origTIds.join(',') !== restoredTIds.join(',')) return false;

        return true;
      }),
      { numRuns: 100 }
    );
  });
});
