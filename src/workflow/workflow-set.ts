import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { findLiteralSecrets } from '../recorder/redactor.js';
import { DescriptiveParseError } from '../state/state-machine-builder.js';
import type { Workflow, WorkflowSet } from '../types.js';

// ajv-formats ships as CJS; under NodeNext esModuleInterop the module object
// itself may not carry call signatures in TypeScript's view.
const addFormats = _addFormats as unknown as (ajv: Ajv2020) => void;

const SECRET_NAME_PATTERN = '^[A-Z][A-Z0-9_]*$';

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
    sandbox: { $ref: '#/$defs/Sandbox' },
    timeoutMs: { type: 'integer', minimum: 1 },
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
          enum: ['click', 'keypress', 'form_submit', 'type', 'select', 'hover', 'scrollIntoView', 'switch_page'],
        },
        selectors: { type: 'array', items: { type: 'string' } },
        value: { type: 'string' },
        variable: { type: 'string' },
        label: { type: 'string' },
        anchor: { $ref: '#/$defs/Anchor' },
        rowBinding: { $ref: '#/$defs/RowBinding' },
        http: { $ref: '#/$defs/Http' },
        visual: { $ref: '#/$defs/Visual' },
        risk: { type: 'string', enum: ['read', 'write', 'delete'] },
        allowHeal: { type: 'boolean' },
        secretRef: { type: 'string', pattern: SECRET_NAME_PATTERN },
        totp: { type: 'boolean' },
        resultZone: { $ref: '#/$defs/ResultZone' },
        waitFor: { $ref: '#/$defs/ScreenWait' },
        timeoutMs: { type: 'integer', minimum: 1 },
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
        finalZone: {
          type: 'object',
          additionalProperties: false,
          properties: {
            selector: { type: 'string', minLength: 1 },
            rect: {
              type: 'object',
              required: ['row', 'col', 'rows', 'cols'],
              additionalProperties: false,
              properties: {
                row: { type: 'integer', minimum: 0 },
                col: { type: 'integer', minimum: 0 },
                rows: { type: 'integer', minimum: 1 },
                cols: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
        resultZone: { $ref: '#/$defs/ResultZone' },
        observedPayloads: { type: 'array', items: { type: 'object' } },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        cols: { type: 'integer', minimum: 1 },
        rows: { type: 'integer', minimum: 1 },
        secrets: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string', pattern: SECRET_NAME_PATTERN },
              { $ref: '#/$defs/SecretReference' },
            ],
          },
        },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
    },
    Rect: {
      type: 'object',
      required: ['row', 'col', 'rows', 'cols'],
      additionalProperties: false,
      properties: {
        row: { type: 'integer', minimum: 0 },
        col: { type: 'integer', minimum: 0 },
        rows: { type: 'integer', minimum: 1 },
        cols: { type: 'integer', minimum: 1 },
      },
    },
    Anchor: {
      type: 'object',
      required: ['role', 'name', 'frame'],
      additionalProperties: false,
      properties: {
        role: { type: 'string', minLength: 1 },
        name: { type: 'string' },
        parent: {
          type: 'object',
          required: ['kind', 'name'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['dialog', 'region', 'heading', 'label'] },
            name: { type: 'string' },
          },
        },
        frame: { type: 'array', items: { type: 'integer', minimum: 0 } },
        frameHints: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string' }, title: { type: 'string' }, src: { type: 'string' } },
          },
        },
        popup: {
          type: 'object',
          required: ['page'],
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 0 },
            opens: { type: 'boolean' },
          },
        },
      },
    },
    RowBinding: {
      type: 'object',
      required: ['container'],
      additionalProperties: false,
      properties: {
        container: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['row', 'card', 'listitem'] },
            role: { type: 'string', minLength: 1 },
            selectorHint: { type: 'string', minLength: 1 },
          },
        },
        key: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            column: { type: 'string', minLength: 1 },
          },
        },
        variable: { type: 'string', minLength: 1 },
      },
    },
    SecretValueRef: {
      type: 'object',
      required: ['$secret'],
      additionalProperties: false,
      properties: { $secret: { type: 'string', pattern: SECRET_NAME_PATTERN } },
    },
    Http: {
      type: 'object',
      required: ['method', 'url', 'query', 'bindings', 'redacted'],
      additionalProperties: false,
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string', minLength: 1 },
        query: {
          type: 'object',
          additionalProperties: { oneOf: [{ type: 'string' }, { $ref: '#/$defs/SecretValueRef' }] },
        },
        body: {},
        bodyFormat: { type: 'string', enum: ['json', 'form', 'text'] },
        headers: {
          type: 'object',
          additionalProperties: {
            oneOf: [{ type: 'string' }, { $ref: '#/$defs/SecretValueRef' }],
          },
        },
        auth: { type: 'string', pattern: '^(storageState|none|env:[A-Z][A-Z0-9_]*)$' },
        expectStatus: { type: 'integer', minimum: 100, maximum: 599 },
        responseShape: { type: 'object' },
        bindings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['variable', 'in', 'name'],
            additionalProperties: false,
            properties: {
              variable: { type: 'string', minLength: 1 },
              in: { type: 'string', enum: ['query', 'body', 'path', 'header'] },
              name: { type: 'string' },
            },
          },
        },
        redacted: {
          type: 'array',
          items: {
            type: 'object',
            required: ['in', 'name', 'secret'],
            additionalProperties: false,
            properties: {
              in: { type: 'string', enum: ['header', 'query', 'body'] },
              name: { type: 'string' },
              secret: { type: 'string', pattern: SECRET_NAME_PATTERN },
            },
          },
        },
      },
    },
    Visual: {
      type: 'object',
      required: ['thumbnailPath', 'rect', 'intent'],
      additionalProperties: false,
      properties: {
        thumbnailPath: { type: 'string', minLength: 1 },
        rect: {
          type: 'object',
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false,
          properties: {
            x: { type: 'number', minimum: 0, maximum: 1 },
            y: { type: 'number', minimum: 0, maximum: 1 },
            w: { type: 'number', minimum: 0, maximum: 1 },
            h: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
        intent: { type: 'string' },
      },
    },
    ScreenWait: {
      type: 'object',
      required: ['pattern', 'timeoutMs'],
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
        when: { type: 'string', enum: ['before', 'after'] },
      },
    },
    ResultZone: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1 },
        rect: { $ref: '#/$defs/Rect' },
        extractor: {
          oneOf: [
            {
              type: 'object',
              required: ['kind'],
              additionalProperties: false,
              properties: { kind: { enum: ['text', 'table', 'list', 'fields', 'json'] } },
            },
            {
              type: 'object',
              required: ['kind'],
              additionalProperties: false,
              properties: { kind: { const: 'attribute' }, name: { type: 'string', minLength: 1 } },
            },
            {
              type: 'object',
              required: ['kind', 'pattern'],
              additionalProperties: false,
              properties: {
                kind: { const: 'regex' },
                pattern: { type: 'string', minLength: 1 },
                flags: { type: 'string', pattern: '^[gimsu]*$' },
              },
            },
          ],
        },
        schema: { type: 'object' },
      },
    },
    SecretReference: {
      type: 'object',
      required: ['name', 'kind'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: SECRET_NAME_PATTERN },
        kind: { type: 'string', enum: ['password', 'totp', 'token', 'header'] },
      },
    },
    Sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', minLength: 1 },
        packages: { type: 'array', items: { type: 'string' } },
        install: { type: 'array', items: { type: 'string' } },
        network: { type: 'string', enum: ['none', 'bridge'] },
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

const PASSWORD_SELECTOR = /type\s*=\s*["']?password/i;
const PASSWORD_LABEL = /pass(word|wd)|mot de passe/i;

/**
 * Find literals that must be Secret_References: a `value` on a step typing a
 * secret (`secretRef`, `totp` or a password field) and any authorization,
 * cookie, set-cookie or token key inside an `http` recipe. Returns JSON paths.
 */
export function findPlainSecrets(set: WorkflowSet): string[] {
  const found: string[] = [];
  (set.workflows ?? []).forEach((workflow, wi) => {
    (workflow.steps ?? []).forEach((step, si) => {
      const base = `$.workflows[${wi}].steps[${si}]`;
      const typesSecret =
        step.secretRef !== undefined ||
        step.totp === true ||
        (step.actionType === 'type' &&
          ((step.selectors ?? []).some((s) => PASSWORD_SELECTOR.test(s)) ||
            (step.label !== undefined && PASSWORD_LABEL.test(step.label))));
      if (typesSecret && step.value !== undefined) found.push(`${base}.value`);
      if (step.http !== undefined) {
        for (const path of findLiteralSecrets(step.http)) found.push(`${base}.http${path}`);
      }
    });
  });
  return found;
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
  const plain = findPlainSecrets(set);
  if (plain.length > 0) {
    throw new Error(
      `Workflow set contains plain-text secrets at ${plain.join(', ')}; use a secretRef or a {"$secret":"NAME"} reference instead`,
    );
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
  const set = parsed as WorkflowSet;
  const plain = findPlainSecrets(set);
  if (plain.length > 0) {
    throw new DescriptiveParseError(
      plain[0],
      'secret-safety',
      `plain-text secret at ${plain.join(', ')}; use a secretRef or a {"$secret":"NAME"} reference`,
    );
  }
  return set;
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
