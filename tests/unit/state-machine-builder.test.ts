import { describe, it, expect } from 'vitest';
import { StateMachineBuilder, DescriptiveParseError } from '../../src/state/state-machine-builder.js';
import { ScreenHasher } from '../../src/state/screen-hasher.js';
import type { StateGraph, ScreenId, ScreenContent, RecordedAction } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hasher = new ScreenHasher();

function domContent(raw: string): ScreenContent {
  return { type: 'dom', raw, normalized: raw, capturedAt: Date.now() };
}

/** Build a minimal valid StateGraph with a single screen and no transitions. */
function minimalGraph(screenIdSuffix: string): StateGraph {
  const id = `abcdef012345${screenIdSuffix}` as ScreenId; // 16-char hex
  return {
    version: '1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    screens: {
      [id]: {
        id,
        type: 'dom',
        normalizedHash: 'a'.repeat(64),
        snapshot: '<html/>',
        firstSeenAt: '2024-01-01T00:00:00.000Z',
        observationCount: 1,
      },
    },
    transitions: [],
  };
}

const SCREEN_ID_A = 'aaaaaaaaaaaaaaaa' as ScreenId;
const SCREEN_ID_B = 'bbbbbbbbbbbbbbbb' as ScreenId;
const HASH_64 = 'c'.repeat(64);
const ISO_DATE = '2024-06-01T12:00:00.000Z';
const UUID_1 = '00000000-0000-0000-0000-000000000001';
const UUID_2 = '00000000-0000-0000-0000-000000000002';

function makeGraph(
  screenId: ScreenId,
  transitionId: string,
  srcId: ScreenId,
  dstId: ScreenId,
): StateGraph {
  return {
    version: '1',
    createdAt: ISO_DATE,
    updatedAt: ISO_DATE,
    screens: {
      [screenId]: {
        id: screenId,
        type: 'dom',
        normalizedHash: HASH_64,
        snapshot: '<html/>',
        firstSeenAt: ISO_DATE,
        observationCount: 1,
      },
    },
    transitions: [
      {
        id: transitionId,
        sourceScreenId: srcId,
        destinationScreenId: dstId,
        actionType: 'click',
        label: 'click_button',
        observedPayloads: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateMachineBuilder', () => {
  describe('merge', () => {
    it('union of node sets: merged graph contains screens from both builders', () => {
      const graphA = minimalGraph('6789');  // id: abcdef0123456789
      const graphB = minimalGraph('abcd');  // id: abcdef012345abcd

      const builder = new StateMachineBuilder();
      builder.merge(graphA);
      builder.merge(graphB);

      const result = builder.getGraph();
      expect(Object.keys(result.screens)).toContain('abcdef0123456789');
      expect(Object.keys(result.screens)).toContain('abcdef012345abcd');
    });

    it('deduplication of identical transitions: only one copy appears after merge', () => {
      const transition = {
        id: UUID_1,
        sourceScreenId: SCREEN_ID_A,
        destinationScreenId: SCREEN_ID_B,
        actionType: 'click' as const,
        label: 'submit',
        observedPayloads: [],
      };
      const graphWithTransition: StateGraph = {
        version: '1',
        createdAt: ISO_DATE,
        updatedAt: ISO_DATE,
        screens: {},
        transitions: [transition],
      };
      // Identical transition but a different UUID — same composite key
      const duplicateGraph: StateGraph = {
        ...graphWithTransition,
        transitions: [{ ...transition, id: UUID_2 }],
      };

      const builder = new StateMachineBuilder();
      builder.merge(graphWithTransition);
      builder.merge(duplicateGraph);

      expect(builder.getGraph().transitions).toHaveLength(1);
    });

    it('preservation of distinct transitions: both transitions appear after merge', () => {
      const graphA: StateGraph = {
        version: '1',
        createdAt: ISO_DATE,
        updatedAt: ISO_DATE,
        screens: {},
        transitions: [
          {
            id: UUID_1,
            sourceScreenId: SCREEN_ID_A,
            destinationScreenId: SCREEN_ID_B,
            actionType: 'click',
            label: 'click_a_to_b',
            observedPayloads: [],
          },
        ],
      };
      const graphB: StateGraph = {
        version: '1',
        createdAt: ISO_DATE,
        updatedAt: ISO_DATE,
        screens: {},
        transitions: [
          {
            id: UUID_2,
            sourceScreenId: SCREEN_ID_B,
            destinationScreenId: SCREEN_ID_A,
            actionType: 'click',
            label: 'click_b_to_a',
            observedPayloads: [],
          },
        ],
      };

      const builder = new StateMachineBuilder();
      builder.merge(graphA);
      builder.merge(graphB);

      expect(builder.getGraph().transitions).toHaveLength(2);
    });
  });

  describe('deserialize', () => {
    it('malformed JSON throws DescriptiveParseError', () => {
      expect(() => StateMachineBuilder.deserialize('not json')).toThrow(DescriptiveParseError);
    });

    it('malformed JSON error message mentions the parse problem', () => {
      let caught: unknown;
      try {
        StateMachineBuilder.deserialize('not json');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DescriptiveParseError);
      expect((caught as DescriptiveParseError).message).toMatch(/invalid json/i);
    });

    it('schema-invalid JSON (missing version) throws DescriptiveParseError', () => {
      const invalid = JSON.stringify({
        // version is intentionally omitted
        createdAt: ISO_DATE,
        updatedAt: ISO_DATE,
        screens: {},
        transitions: [],
      });
      expect(() => StateMachineBuilder.deserialize(invalid)).toThrow(DescriptiveParseError);
    });

    it('DescriptiveParseError for missing version carries identifying info', () => {
      const invalid = JSON.stringify({
        createdAt: ISO_DATE,
        updatedAt: ISO_DATE,
        screens: {},
        transitions: [],
      });
      let caught: unknown;
      try {
        StateMachineBuilder.deserialize(invalid);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DescriptiveParseError);
      // The error should reference 'version' or 'required' in its path/message
      const err = caught as DescriptiveParseError;
      const details = err.message + err.instancePath + err.schemaPath;
      expect(details.toLowerCase()).toMatch(/version|required/);
    });

    it('valid JSON round-trips successfully', () => {
      const builder = new StateMachineBuilder();
      const json = builder.serialize();
      expect(() => StateMachineBuilder.deserialize(json)).not.toThrow();
    });
  });

  describe('recordTransition snapshot deduplication', () => {
    it('recording the same screen twice within 100ms inserts only one screen node', () => {
      const builder = new StateMachineBuilder({ snapshotIntervalMs: 100 });
      const now = Date.now();
      const src = SCREEN_ID_A;
      const action: RecordedAction = { actionType: 'click', selector: '#btn' };

      const content: ScreenContent = {
        type: 'dom',
        raw: '<div>hello</div>',
        normalized: '<div>hello</div>',
        capturedAt: now,
      };

      // First recording
      builder.recordTransition(src, action, content);

      // Second recording with same hash, within interval (capturedAt + 50ms < interval)
      const contentAgain: ScreenContent = { ...content, capturedAt: now + 50 };
      builder.recordTransition(src, action, contentAgain);

      const screens = builder.getGraph().screens;
      // Only one screen node should exist (the destination)
      const destinationId = new ScreenHasher().computeId(content);
      expect(screens[destinationId]).toBeDefined();
      expect(screens[destinationId].observationCount).toBe(1);
    });

    it('recording the same screen after the interval creates a second observation', () => {
      const builder = new StateMachineBuilder({ snapshotIntervalMs: 100 });
      const now = Date.now();
      const src = SCREEN_ID_A;
      const action: RecordedAction = { actionType: 'click', selector: '#btn' };

      const content: ScreenContent = {
        type: 'dom',
        raw: '<div>hello</div>',
        normalized: '<div>hello</div>',
        capturedAt: now,
      };

      builder.recordTransition(src, action, content);

      // Second recording after the interval has elapsed
      const contentLater: ScreenContent = { ...content, capturedAt: now + 200 };
      builder.recordTransition(src, action, contentLater);

      const destinationId = new ScreenHasher().computeId(content);
      expect(builder.getGraph().screens[destinationId].observationCount).toBe(2);
    });
  });
});
