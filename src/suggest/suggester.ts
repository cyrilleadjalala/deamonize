/**
 * Compile-time suggestions (requirement 18.1 to 18.3). A Suggester proposes tool names, descriptions, variable
 * descriptions, candidate Variables, correlated network parameters and a Result_Zone. It never changes a recording:
 * the suggestions go to an editable file and only accepted ones are applied (see apply.ts), and only to names and
 * texts.
 */
import type { WorkflowSet } from '../types.js';

export interface SuggestedVariable {
  name: string;
  description?: string;
  type?: 'string' | 'number' | 'boolean';
  optional?: boolean;
}

/** A typed or selected constant that could be a Variable. `name` is an optional proposal for it. */
export interface CandidateVariable {
  stepIndex: number;
  reason: string;
  name?: string;
}

export interface SuggestedResultZone {
  selector?: string;
  rect?: { row: number; col: number; rows: number; cols: number };
  extractor?: { kind: 'text' | 'table' | 'list' | 'fields' | 'json' };
}

export interface CorrelatedParam {
  stepIndex: number;
  variable: string;
  in: 'query' | 'body' | 'path' | 'header';
  name: string;
}

export interface WorkflowSuggestion {
  id: string;
  /** Nothing of this entry is applied by `compile` until the user sets it to true. */
  accepted?: boolean;
  toolName?: string;
  description?: string;
  variables?: SuggestedVariable[];
  candidateVariables?: CandidateVariable[];
  resultZone?: SuggestedResultZone;
  correlatedParams?: CorrelatedParam[];
}

export interface SuggestionSet {
  version: '1';
  source: 'deterministic' | 'model';
  /** `provider/model` when source is `model`. */
  model?: string;
  /** Why the deterministic rules ran although a model was wanted. */
  fallbackReason?: string;
  workflows: WorkflowSuggestion[];
}

export interface SuggestContext {
  /** Serialized HTML of the final screen of each workflow (by workflow id), when it is available. */
  finalSnapshots?: ReadonlyMap<string, string>;
}

export interface Suggester {
  suggest(set: WorkflowSet, context?: SuggestContext): Promise<SuggestionSet>;
}

// ---------------------------------------------------------------------------
// Strict schema (AJV) of a suggestion file and of a model answer
// ---------------------------------------------------------------------------
const RECT = {
  type: 'object',
  properties: {
    row: { type: 'integer', minimum: 0 },
    col: { type: 'integer', minimum: 0 },
    rows: { type: 'integer', minimum: 1 },
    cols: { type: 'integer', minimum: 1 },
  },
  required: ['row', 'col', 'rows', 'cols'],
  additionalProperties: false,
};

export const WORKFLOW_SUGGESTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    accepted: { type: 'boolean' },
    toolName: { type: 'string', maxLength: 200 },
    description: { type: 'string', maxLength: 4000 },
    variables: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 4000 },
          type: { enum: ['string', 'number', 'boolean'] },
          optional: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    candidateVariables: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          stepIndex: { type: 'integer', minimum: 0 },
          reason: { type: 'string', maxLength: 4000 },
          name: { type: 'string', maxLength: 200 },
        },
        required: ['stepIndex', 'reason'],
        additionalProperties: false,
      },
    },
    resultZone: {
      type: 'object',
      properties: {
        selector: { type: 'string', maxLength: 1000 },
        rect: RECT,
        extractor: {
          type: 'object',
          properties: { kind: { enum: ['text', 'table', 'list', 'fields', 'json'] } },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    correlatedParams: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          stepIndex: { type: 'integer', minimum: 0 },
          variable: { type: 'string', maxLength: 200 },
          in: { enum: ['query', 'body', 'path', 'header'] },
          name: { type: 'string', maxLength: 1000 },
        },
        required: ['stepIndex', 'variable', 'in', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['id'],
  additionalProperties: false,
};

export const SUGGESTION_SET_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    version: { const: '1' },
    source: { enum: ['deterministic', 'model'] },
    model: { type: 'string', maxLength: 300 },
    fallbackReason: { type: 'string', maxLength: 1000 },
    workflows: { type: 'array', maxItems: 1000, items: WORKFLOW_SUGGESTION_SCHEMA },
  },
  required: ['version', 'source', 'workflows'],
  additionalProperties: false,
};
