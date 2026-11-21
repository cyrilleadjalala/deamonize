/**
 * One closed JSON Schema per tool (`additionalProperties: false`) and its Ajv validator. The schema that Kiro sees is the
 * schema that is enforced, so a field that is not listed is refused (and named) before any request is made.
 * The only open object is `arguments` of `test_action`: it holds the arguments of the tool under test, whose own
 * schema the Playground checks.
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { STUDIO_MCP_TOOL_NAMES, type StudioMcpToolName } from './tool-names.js';
import { TOOL_TEXTS } from './texts.js';

export type JsonSchema = Record<string, unknown>;

const id: JsonSchema = { type: 'string', minLength: 1, maxLength: 200 };
const scope: JsonSchema = { type: 'string', enum: ['global', 'project'] };
const closed = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});

export const INPUT_SCHEMAS: Record<StudioMcpToolName, JsonSchema> = {
  list_actions: closed({}),
  get_action: closed({ id }, ['id']),
  list_credentials: closed({}),
  get_activity: closed({ limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many entries, from 1 to 100 (default 20).' } }),
  start_recording: closed(
    {
      name: { type: 'string', minLength: 1, maxLength: 100, description: 'A plain name for the action.' },
      url: { type: 'string', minLength: 1, maxLength: 2048, description: 'The web address to start from.' },
      reuseSession: { type: 'boolean', description: 'Start already signed in, with the saved session.' },
    },
    ['name', 'url']
  ),
  get_recording_status: closed({}),
  finish_recording: closed({}),
  compile: closed({
    http: { type: 'string', enum: ['off', 'auto'], description: 'auto runs recorded web requests directly when it can.' },
    healSupport: { type: 'boolean', description: 'Build in the support for healing a changed page.' },
  }),
  test_action: closed(
    {
      tool: { type: 'string', minLength: 1, maxLength: 200, description: 'The name of the built tool.' },
      arguments: { type: 'object', description: 'The inputs of that tool. Never put a password or token here.' },
      mode: { type: 'string', enum: ['strict', 'heal'] },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
      confirm: { type: 'boolean', description: 'Needed for a tool that changes data.' },
    },
    ['tool']
  ),
  preview_kiro_install: closed({ scope }, ['scope']),
  install_to_kiro: closed({ scope, confirmationId: { type: 'string', minLength: 1, maxLength: 200 } }, ['scope', 'confirmationId']),
  update_action: closed(
    {
      id,
      confirm: { type: 'boolean' },
      label: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 2000 },
      variables: {
        type: 'array',
        maxItems: 100,
        items: closed({
          name: { type: 'string', minLength: 1, maxLength: 100 },
          newName: { type: 'string', minLength: 1, maxLength: 100 },
          type: { type: 'string', enum: ['string', 'number', 'boolean'] },
          optional: { type: 'boolean' },
          whenOmitted: { type: 'string', enum: ['useRecorded', 'skip'] },
          description: { type: 'string', maxLength: 2000 },
        }, ['name']),
      },
    },
    ['id']
  ),
  delete_action: closed({ id, confirm: { type: 'boolean' } }, ['id']),
};

/** The tools that only read. Used for the MCP annotations. */
export const READ_ONLY_TOOLS: ReadonlySet<StudioMcpToolName> = new Set<StudioMcpToolName>(['list_actions', 'get_action', 'list_credentials', 'get_activity', 'get_recording_status', 'preview_kiro_install']);

export interface ToolDescriptor {
  name: StudioMcpToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

/** The list the server publishes, in the order of the design. */
export function describeTools(): ToolDescriptor[] {
  return STUDIO_MCP_TOOL_NAMES.map((name) => ({
    name,
    title: TOOL_TEXTS[name].title,
    description: TOOL_TEXTS[name].description,
    inputSchema: INPUT_SCHEMAS[name],
    annotations: { readOnlyHint: READ_ONLY_TOOLS.has(name), destructiveHint: name === 'delete_action', openWorldHint: false },
  }));
}

export interface ArgumentProblem {
  error: 'unknown_field' | 'invalid_argument';
  message: string;
  field: string;
}
export type Validated = { ok: true; value: Record<string, unknown> } | ({ ok: false } & ArgumentProblem);

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map<StudioMcpToolName, ValidateFunction>();
for (const name of STUDIO_MCP_TOOL_NAMES) validators.set(name, ajv.compile(INPUT_SCHEMAS[name]));

/** A field name that is safe to echo: short, no control characters. */
const shown = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 60);

function fieldOf(error: ErrorObject): string {
  const parts = error.instancePath.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (error.keyword === 'required') parts.push(String((error.params as { missingProperty?: unknown }).missingProperty));
  return parts.length === 0 ? 'arguments' : shown(parts.join('.'));
}

function describe(error: ErrorObject): string {
  const field = fieldOf(error);
  const schema = error.parentSchema as JsonSchema | undefined;
  switch (error.keyword) {
    case 'required':
      return `${field} is needed.`;
    case 'type': {
      const type = String((error.params as { type?: unknown }).type);
      return type === 'integer' ? `${field} must be a whole number${rangeText(schema)}.` : `${field} must be ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}.`;
    }
    case 'minimum':
    case 'maximum':
      return `${field} must be a whole number${rangeText(schema)}.`;
    case 'minLength':
    case 'maxLength':
      return `${field} must be between ${String(schema?.minLength ?? 0)} and ${String(schema?.maxLength ?? 'the limit')} characters long.`;
    case 'enum':
      return `${field} must be one of: ${((schema?.enum as unknown[] | undefined) ?? []).join(', ')}.`;
    case 'maxItems':
      return `${field} has too many items.`;
    default:
      return `${field} is not valid.`;
  }
}

function rangeText(schema: JsonSchema | undefined): string {
  if (schema === undefined || typeof schema.minimum !== 'number' || typeof schema.maximum !== 'number') return '';
  return ` from ${schema.minimum} to ${schema.maximum}`;
}

/** Checks the arguments of a call against the closed schema. Nothing is changed or removed. */
export function validateInput(name: StudioMcpToolName, args: unknown): Validated {
  const validate = validators.get(name);
  if (validate === undefined) return { ok: false, error: 'invalid_argument', field: 'tool', message: 'There is no tool with this name.' };
  const input = args === undefined || args === null ? {} : args;
  if (validate(input)) return { ok: true, value: input as Record<string, unknown> };
  const errors = validate.errors ?? [];
  const extra = errors.find((e) => e.keyword === 'additionalProperties');
  if (extra !== undefined) {
    const field = shown(String((extra.params as { additionalProperty?: unknown }).additionalProperty));
    const where = extra.instancePath === '' ? field : `${fieldOf(extra)}.${field}`;
    return { ok: false, error: 'unknown_field', field: where, message: `${where} is not a field of ${name}.` };
  }
  const first = errors[0];
  return { ok: false, error: 'invalid_argument', field: first === undefined ? 'arguments' : fieldOf(first), message: first === undefined ? 'The arguments are not valid.' : describe(first) };
}
