import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { findLiteralSecrets } from '../recorder/redactor.js';
import { DescriptiveParseError } from '../state/state-machine-builder.js';
import type { WorkflowSet } from '../types.js';

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
          enum: ['click', 'keypress', 'form_submit', 'type', 'select', 'hover', 'scrollIntoView', 'switch_page', 'check'],
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
      // A check step holds the state to reach: the text true or false
      allOf: [
        {
          if: { properties: { actionType: { const: 'check' } }, required: ['actionType'] },
          then: { required: ['value'], properties: { value: { enum: ['true', 'false'] } } },
        },
      ],
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
        whenOmitted: { type: 'string', enum: ['useRecorded', 'skip'] },
        enum: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
        pattern: { type: 'string', minLength: 1 },
        maxLength: { type: 'integer', minimum: 1 },
      },
      // whenOmitted only means something for an optional Variable
      allOf: [
        {
          if: { required: ['whenOmitted'] },
          then: { required: ['optional'], properties: { optional: { const: true } } },
        },
      ],
    },
    Workflow: {
      type: 'object',
      required: ['id', 'label', 'steps', 'variables', 'observedPayloads'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', format: 'uuid' },
        label: { type: 'string', minLength: 1 },
        description: { type: 'string', maxLength: 1000 },
        startUrl: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://\\S+$' },
        storageState: { oneOf: [{ type: 'string', minLength: 1, maxLength: 1024 }, { type: 'null' }] },
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
      required: ['rect', 'intent'],
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
      required: ['timeoutMs'],
      oneOf: [{ required: ['pattern'] }, { required: ['text'] }],
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 500 },
        text: { type: 'string', minLength: 1, maxLength: 500 },
        flags: { type: 'string', pattern: '^[imsu]*$' },
        region: { $ref: '#/$defs/Rect' },
        mode: { type: 'string', enum: ['appear', 'disappear'] },
        timeoutMs: { type: 'integer', minimum: 1 },
        when: { type: 'string', enum: ['before', 'after'] },
      },
    },
    ResultZone: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: { type: 'string', minLength: 1 },
        selectors: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 300 } },
        fingerprint: {
          type: 'object',
          required: ['tag', 'kind'],
          additionalProperties: false,
          properties: {
            tag: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,30}$' },
            kind: { enum: ['text', 'table', 'list', 'fields', 'json', 'attribute', 'regex'] },
            count: { type: 'integer', minimum: 1 },
          },
        },
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
        image: { type: 'string', minLength: 1, maxLength: 255 },
        packages: { type: 'array', maxItems: 100, items: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9.+_:-]*$' } },
        install: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\r\\n\\u0000]*$' } },
        network: { type: 'string', enum: ['none', 'bridge'] },
        user: { type: 'string', minLength: 1 },
        workdir: { type: 'string', minLength: 1 },
        mounts: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
  },
};

interface SchemaErrorLike {
  instancePath: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

const FIELD_MESSAGES: Record<string, string> = {
  description: 'description must be a text of at most 1000 characters',
  startUrl: 'startUrl must be an absolute http or https address of at most 2048 characters',
  storageState: 'storageState must be a file path of at most 1024 characters, or null',
};

/**
 * Maps an Ajv error to a sentence that names the workflow id and the Variable or field it is about.
 * An error outside a workflow keeps the message of the validator.
 */
export function describeSchemaError(set: unknown, error: SchemaErrorLike): string {
  const base = error.message ?? 'Unknown validation error';
  const parts = (error.instancePath ?? '').split('/').slice(1);
  if (parts[0] !== 'workflows' || parts.length < 2) return base;
  const workflows = (set as { workflows?: unknown } | null)?.workflows;
  const workflow = Array.isArray(workflows) ? (workflows[Number(parts[1])] as Record<string, any> | undefined) : undefined;
  const id = typeof workflow?.id === 'string' ? workflow.id : `#${parts[1]}`;
  const head = `workflow "${id}"`;
  if (parts[2] === 'variables' && parts.length >= 4) {
    const variable = Array.isArray(workflow?.variables) ? (workflow.variables[Number(parts[3])] as Record<string, unknown> | undefined) : undefined;
    const name = typeof variable?.name === 'string' ? variable.name : `#${parts[3]}`;
    const field = parts[4];
    if (field === 'whenOmitted') return `${head}, variable "${name}": whenOmitted must be useRecorded or skip`;
    if ((field === 'optional' && variable?.whenOmitted !== undefined) || (field === undefined && error.params?.missingProperty === 'optional')) {
      return `${head}, variable "${name}": whenOmitted needs optional: true`;
    }
    return `${head}, variable "${name}"${field === undefined ? '' : `, ${field}`}: ${base}`;
  }
  if (parts[2] === 'steps' && parts.length >= 4) {
    const step = Array.isArray(workflow?.steps) ? (workflow.steps[Number(parts[3])] as Record<string, unknown> | undefined) : undefined;
    const where = `${head}, step ${Number(parts[3]) + 1}`;
    if (step?.actionType === 'check' && (parts[4] === 'value' || (parts[4] === undefined && error.params?.missingProperty === 'value'))) {
      return `${where}: a check step needs the value "true" or "false"`;
    }
    return `${where}${parts[4] === undefined ? '' : `, ${parts[4]}`}: ${base}`;
  }
  const field = parts[2];
  if (field !== undefined && FIELD_MESSAGES[field] !== undefined) return `${head}: ${FIELD_MESSAGES[field]}`;
  return `${head}${field === undefined ? '' : `, ${field}`}: ${base}`;
}

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
    // An `if` error only repeats the error of its `then` branch: the later one says what is wrong
    const firstError = validate.errors.find((error) => error.keyword !== 'if') ?? validate.errors[0];
    throw new DescriptiveParseError(
      firstError.instancePath ?? '',
      firstError.schemaPath ?? '',
      describeSchemaError(parsed, firstError),
    );
  }
  const set = parsed as WorkflowSet;
  set.workflows.forEach((workflow, w) => {
    if (workflow.startUrl === undefined) return;
    let protocol = '';
    try {
      protocol = new URL(workflow.startUrl).protocol;
    } catch {
      // refused below
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new DescriptiveParseError(`/workflows/${w}/startUrl`, 'workflow-start-url', `workflow "${workflow.id}": startUrl must be an absolute http or https address`);
    }
  });
  // The server checks every value against the pattern of its Variable: a pattern that is not an expression would only fail at compile
  set.workflows.forEach((workflow, w) => {
    workflow.variables.forEach((variable, v) => {
      if (variable.pattern === undefined) return;
      try {
        new RegExp(variable.pattern, 'u');
      } catch (err) {
        throw new DescriptiveParseError(`/workflows/${w}/variables/${v}/pattern`, 'variable-pattern', `Invalid regular expression: ${(err as Error).message}`);
      }
    });
  });
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

export { mergeWorkflowSets } from './merge.js';

/** A copy of the set without the thumbnail paths of the Visual_Anchors (their rect and intent stay). */
export function withoutThumbnails(set: WorkflowSet): WorkflowSet {
  const copy = structuredClone(set);
  for (const workflow of copy.workflows ?? []) {
    for (const step of workflow.steps ?? []) {
      if (step.visual !== undefined) delete step.visual.thumbnailPath;
    }
  }
  return copy;
}
