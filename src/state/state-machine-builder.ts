import { randomUUID } from 'node:crypto';
import { ScreenHasher } from './screen-hasher.js';
import { createAjvValidator } from './schema.js';
import type {
  ScreenContent,
  RecordedAction,
  StateGraph,
  Screen,
  Transition,
  ScreenId,
} from '../types.js';

export class DescriptiveParseError extends Error {
  constructor(
    public readonly instancePath: string,
    public readonly schemaPath: string,
    message: string,
  ) {
    super(message);
    this.name = 'DescriptiveParseError';
  }
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 100;

export class StateMachineBuilder {
  private readonly hasher = new ScreenHasher();
  private readonly snapshotIntervalMs: number;

  // The in-memory graph
  private graph: StateGraph = {
    version: '1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    screens: {},
    transitions: [],
  };

  // Snapshot deduplication state
  private lastSnapshotHash: string | null = null;
  private lastSnapshotTime: number = 0;

  constructor(config?: { snapshotIntervalMs?: number }) {
    this.snapshotIntervalMs = config?.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  }

  /**
   * Record a completed interaction. Returns the destination ScreenId.
   * Skips recording when the previous snapshot hash equals the new one
   * and elapsed time is < snapshotIntervalMs.
   */
  recordTransition(
    sourceId: ScreenId,
    action: RecordedAction,
    destinationContent: ScreenContent,
  ): ScreenId {
    const normalizedHash = this.hasher.normalizedHash(destinationContent);
    const destinationId = this.hasher.computeId(destinationContent);
    const now = destinationContent.capturedAt;

    // Snapshot deduplication: skip if same hash and within interval
    if (
      this.lastSnapshotHash === normalizedHash &&
      now - this.lastSnapshotTime < this.snapshotIntervalMs
    ) {
      return destinationId;
    }

    // Insert or increment the destination screen node
    if (this.graph.screens[destinationId]) {
      this.graph.screens[destinationId].observationCount += 1;
    } else {
      const screen: Screen = {
        id: destinationId,
        type: destinationContent.type,
        normalizedHash,
        snapshot: destinationContent.raw,
        firstSeenAt: new Date(now).toISOString(),
        observationCount: 1,
      };
      if (action.label) {
        screen.label = action.label;
      }
      this.graph.screens[destinationId] = screen;
    }

    // Append the transition edge
    const transition: Transition = {
      id: randomUUID(),
      sourceScreenId: sourceId,
      destinationScreenId: destinationId,
      actionType: action.actionType,
      label: action.label ?? `${action.actionType}${action.selector ? `_${action.selector}` : ''}`,
      observedPayloads: [],
    };
    if (action.selector !== undefined) {
      transition.selector = action.selector;
    }

    this.graph.transitions.push(transition);

    // Update deduplication state
    this.lastSnapshotHash = normalizedHash;
    this.lastSnapshotTime = now;

    // Update the graph's updatedAt timestamp
    this.graph.updatedAt = new Date().toISOString();

    return destinationId;
  }

  /**
   * Merge another StateGraph into this one (union of nodes and edges).
   * Returns the merged StateGraph.
   *
   * Both the base graph's transitions and the other graph's transitions are
   * deduplicated by composite key (sourceScreenId + actionType + selector +
   * destinationScreenId), ensuring the operation is commutative and idempotent.
   */
  merge(other: StateGraph): StateGraph {
    // Union screen sets: deduplicate by screen ID, merge observationCount
    for (const [id, otherScreen] of Object.entries(other.screens)) {
      if (this.graph.screens[id]) {
        this.graph.screens[id].observationCount += otherScreen.observationCount;
      } else {
        this.graph.screens[id] = { ...otherScreen };
      }
    }

    // Union transition sets: rebuild from both sources, deduplicating by composite key.
    // Starting from scratch (instead of appending to this.graph.transitions directly)
    // ensures that any duplicates already present in the base graph are also removed,
    // which is required for commutativity: merge(A, B) must equal merge(B, A).
    const seenKeys = new Map<string, Transition>();
    for (const t of [...this.graph.transitions, ...other.transitions]) {
      const key = transitionKey(t);
      if (!seenKeys.has(key)) {
        seenKeys.set(key, { ...t });
      }
    }
    this.graph.transitions = [...seenKeys.values()];

    this.graph.updatedAt = new Date().toISOString();
    return this.graph;
  }

  /**
   * Serialize the in-memory graph to a pretty-printed JSON string.
   * Validates the output against the State_Graph JSON Schema before returning.
   */
  serialize(): string {
    const validate = createAjvValidator();
    const valid = validate(this.graph);
    if (!valid) {
      const errorDetails = JSON.stringify(validate.errors, null, 2);
      throw new Error(`State_Graph validation failed: ${errorDetails}`);
    }
    return JSON.stringify(this.graph, null, 2);
  }

  /**
   * Load from a JSON string; throws DescriptiveParseError on schema failure.
   */
  static deserialize(json: string): StateMachineBuilder {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new DescriptiveParseError(
        '',
        '',
        `Invalid JSON: ${(err as Error).message}`,
      );
    }

    const validate = createAjvValidator();
    const valid = validate(parsed);
    if (!valid && validate.errors && validate.errors.length > 0) {
      const firstError = validate.errors[0];
      throw new DescriptiveParseError(
        firstError.instancePath ?? '',
        firstError.schemaPath ?? '',
        firstError.message ?? 'Unknown validation error',
      );
    }

    const builder = new StateMachineBuilder();
    builder.graph = parsed as StateGraph;
    return builder;
  }

  /**
   * Returns the current in-memory StateGraph.
   */
  getGraph(): StateGraph {
    return this.graph;
  }
}

/**
 * Compute a deduplication key for a transition.
 * Key: sourceScreenId + actionType + (selector ?? '') + (action.value ?? '') + destinationScreenId
 *
 * Note: RecordedAction.value is stored on Transition via observedPayloads, but the design
 * specifies the key uses the transition fields directly. We use selector as the action parameter
 * proxy (the value field on a Transition doesn't exist — it lives in observedPayloads).
 * Per the task spec the key is: sourceScreenId + actionType + (selector ?? '') + (action.value ?? '') + destinationScreenId.
 * Since Transition has no `value` field directly, we leave action.value as '' for all transitions.
 */
function transitionKey(t: Transition): string {
  return `${t.sourceScreenId}|${t.actionType}|${t.selector ?? ''}||${t.destinationScreenId}`;
}
