import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { DescriptiveParseError } from '../state/state-machine-builder.js';
import type { Workflow, WorkflowSet } from '../types.js';

// ajv-formats ships as CJS; under NodeNext esModuleInterop the module object
// itself may not carry call signatures in TypeScript's view.
const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;

/**
 * JSON Schema (draft 2020-12) for the persisted Workflow set.
 */
export const WorkflowSetSchema: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://daemonize.dev/schemas/workflow-set/v1',
  type: 'object',
  required: ['version', 'targetType', 'targetName', 'workflows'],
  additionalProperties: false,
  properties: {
    version: { type: 'string', const: '1' },
    targetType: { type: 'string', enum: ['web', 'tui'] },
    targetName: { type: 'string' },
    startUrl: { type: 'string' },
    startCommand: { type: 'array', minItems: 1, items: { type: 'string' } },
    storageState: { type: 'string' },
    workflows: { type: 'array', items: { $ref: '#/$defs/Workflow' } },
  },
  // A web target needs its URL, a terminal target its command
  allOf: [
    {
      if: { properties: { targetType: { const: 'web' } } },
      then: { required: ['startUrl'] },
    },
    {
      if: { properties: { targetType: { const: 'tui' } } },
      then: { required: ['startCommand'] },
    },
  ],
  $defs: {
    Step: {
      type: 'object',
      required: ['actionType', 'selectors'],
      additionalProperties: false,
      properties: {
        actionType: {
          type: 'string',
          enum: ['click', 'keypress', 'form_submit', 'type', 'select'],
        },
        selectors: { type: 'array', items: { type: 'string' } },
        value: { type: 'string' },
        variable: { type: 'string' },
        label: { type: 'string' },
      },
    },
    Variable: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['string', 'number', 'boolean'] },
        description: { type: 'string' },
        optional: { type: 'boolean' },
      },
    },
    Workflow: {
      type: 'object',
      required: ['id', 'label', 'steps', 'variables', 'observedPayloads'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        label: { type: 'string', minLength: 1 },
        steps: { type: 'array', minItems: 1, items: { $ref: '#/$defs/Step' } },
        variables: { type: 'array', items: { $ref: '#/$defs/Variable' } },
        finalScreenId: { type: 'string', pattern: '^[0-9a-f]{16}$' },
        observedPayloads: { type: 'array', items: { type: 'object' } },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    },
  },
};

let compiled: ValidateFunction | undefined;

function createValidator(): ValidateFunction {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    compiled = ajv.compile(WorkflowSetSchema);
  }
  return compiled;
}

/**
 * Serialize a Workflow set to pretty-printed JSON (2-space indentation),
 * validating it against the Workflow set JSON Schema first.
 */
export function serializeWorkflowSet(set: WorkflowSet): string {
  const validate = createValidator();
  if (!validate(set)) {
    throw new Error(`Workflow set validation failed: ${JSON.stringify(validate.errors, null, 2)}`);
  }
  return JSON.stringify(set, null, 2);
}

/**
 * Load a Workflow set from JSON; throws DescriptiveParseError on failure.
 */
export function deserializeWorkflowSet(json: string): WorkflowSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new DescriptiveParseError('', '', `Invalid JSON: ${(err as Error).message}`);
  }

  const validate = createValidator();
  if (!validate(parsed) && validate.errors && validate.errors.length > 0) {
    const firstError = validate.errors[0];
    throw new DescriptiveParseError(
      firstError.instancePath ?? '',
      firstError.schemaPath ?? '',
      firstError.message ?? 'Unknown validation error',
    );
  }
  return parsed as WorkflowSet;
}

/**
 * Merge two Workflow sets: keep the union of their Workflows; when both hold a
 * Workflow with the same id, the one from `newer` replaces the one from `base`.
 * The target settings come from `newer`. Neither input is mutated.
 */
export function mergeWorkflowSets(base: WorkflowSet, newer: WorkflowSet): WorkflowSet {
  const byId = new Map<string, Workflow>();
  for (const workflow of [...base.workflows, ...newer.workflows]) {
    byId.set(workflow.id, structuredClone(workflow));
  }
  return { ...structuredClone(newer), workflows: [...byId.values()] };
}
