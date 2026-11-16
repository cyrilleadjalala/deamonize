// @ts-check
/**
 * Pure helpers of the playground form: a JSON Schema becomes a list of fields, and what the person typed becomes the
 * `arguments` of a call. No DOM here, so the same functions run in the page and in the unit tests.
 *
 * The server validates the arguments again with the full schema before the generated server is asked; these checks
 * only catch what the form can say right away (a missing required value, a number that is not one, broken JSON).
 */

/**
 * @typedef {{
 *   name: string,
 *   kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json',
 *   inputType: 'text' | 'password' | 'email' | 'url' | 'date' | 'datetime-local' | 'time' | 'number' | 'checkbox' | 'select' | 'textarea',
 *   required: boolean,
 *   description: string,
 *   format?: string,
 *   options?: string[],
 *   defaultValue?: unknown,
 *   min?: number, max?: number, minLength?: number, maxLength?: number, pattern?: string,
 *   sensitive: boolean,
 * }} Field
 */

const FORM_INPUT = {
  email: 'email',
  uri: 'url',
  url: 'url',
  date: 'date',
  'date-time': 'datetime-local',
  time: 'time',
  password: 'password',
};

/** Names that hold a typed credential, even when the workflow did not say so. */
const SENSITIVE_NAME = /pass(word|wd|phrase|code)?|secret|token|(^|[^a-z])t?otp($|[^a-z])|api[-_ ]?key|credential|cvv/i;

/** @param {unknown} v @returns {Record<string, any> | undefined} */
const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : undefined);

/** The type of a property: the first of a type list that is not `null`. */
function typeOf(schema) {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== 'null');
  return t;
}

/**
 * The fields of an input schema, required ones first, in schema order otherwise. `_timeoutMs` is never a field.
 * @param {unknown} schema
 * @param {string[]} [sensitiveNames] argument names that hold a secret
 * @returns {Field[]}
 */
export function fieldsFromSchema(schema, sensitiveNames = []) {
  const s = obj(schema);
  const properties = obj(s?.properties) ?? {};
  const required = new Set(Array.isArray(s?.required) ? s.required : []);
  const sensitive = new Set(sensitiveNames.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '')));
  /** @type {Field[]} */
  const fields = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (name === '_timeoutMs') continue;
    const p = obj(raw) ?? {};
    const type = typeOf(p);
    const isSensitive = p.format === 'password' || p.writeOnly === true || SENSITIVE_NAME.test(name) || sensitive.has(name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    /** @type {Field} */
    const field = {
      name,
      kind: 'string',
      inputType: 'text',
      required: required.has(name),
      description: typeof p.description === 'string' ? p.description : '',
      sensitive: isSensitive,
    };
    if (Array.isArray(p.enum) && p.enum.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
      field.kind = 'enum';
      field.inputType = 'select';
      field.options = p.enum.map(String);
    } else if (type === 'boolean') {
      field.kind = 'boolean';
      field.inputType = 'checkbox';
    } else if (type === 'integer' || type === 'number') {
      field.kind = type;
      field.inputType = 'number';
      if (typeof p.minimum === 'number') field.min = p.minimum;
      if (typeof p.maximum === 'number') field.max = p.maximum;
    } else if (type === 'object' || type === 'array') {
      field.kind = 'json';
      field.inputType = 'textarea';
    } else {
      if (typeof p.format === 'string') {
        field.format = p.format;
        field.inputType = /** @type {any} */ (FORM_INPUT[/** @type {keyof typeof FORM_INPUT} */ (p.format)] ?? 'text');
      }
      if (isSensitive) field.inputType = 'password';
      if (typeof p.minLength === 'number') field.minLength = p.minLength;
      if (typeof p.maxLength === 'number') field.maxLength = p.maxLength;
      if (typeof p.pattern === 'string') field.pattern = p.pattern;
    }
    if (p.default !== undefined) field.defaultValue = p.default;
    fields.push(field);
  }
  return fields.sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * One line that says what a field accepts, for the help text under it.
 * @param {Field} f
 */
export function describeField(f) {
  const bits = [];
  if (f.kind === 'enum') bits.push(`one of ${(f.options ?? []).join(', ')}`);
  else if (f.kind === 'integer') bits.push('whole number');
  else if (f.kind === 'number') bits.push('number');
  else if (f.kind === 'boolean') bits.push('true or false');
  else if (f.kind === 'json') bits.push('JSON');
  else bits.push(f.format ? `text (${f.format})` : 'text');
  if (f.min !== undefined) bits.push(`min ${f.min}`);
  if (f.max !== undefined) bits.push(`max ${f.max}`);
  if (f.minLength !== undefined) bits.push(`at least ${f.minLength} characters`);
  if (f.maxLength !== undefined) bits.push(`at most ${f.maxLength} characters`);
  if (f.pattern !== undefined) bits.push(`pattern ${f.pattern}`);
  return bits.join(' \u00B7 ');
}

/**
 * The value a field gets from the text typed in it.
 * `omit` is true for an empty optional field: the argument is left out, as an agent would.
 * @param {Field} field
 * @param {string | boolean | undefined} raw
 * @returns {{ ok: true, omit: boolean, value?: unknown } | { ok: false, message: string }}
 */
export function coerceValue(field, raw) {
  if (field.kind === 'boolean') {
    // An unchecked optional box is "not given"; a required one is false
    if (raw === true) return { ok: true, omit: false, value: true };
    return field.required ? { ok: true, omit: false, value: false } : { ok: true, omit: true };
  }
  const text = typeof raw === 'string' ? raw : '';
  // Nothing typed (or only blanks where blanks mean nothing): required means an error, optional means left out
  if (text === '' || (field.kind !== 'string' && text.trim() === '')) {
    return field.required ? { ok: false, message: 'This field is required.' } : { ok: true, omit: true };
  }
  if (field.kind === 'integer' || field.kind === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n)) return { ok: false, message: 'Enter a number.' };
    if (field.kind === 'integer' && !Number.isInteger(n)) return { ok: false, message: 'Enter a whole number.' };
    return { ok: true, omit: false, value: n };
  }
  if (field.kind === 'json') {
    try {
      return { ok: true, omit: false, value: JSON.parse(text) };
    } catch {
      return { ok: false, message: 'Enter valid JSON.' };
    }
  }
  if (field.kind === 'enum') {
    return { ok: true, omit: false, value: text };
  }
  return { ok: true, omit: false, value: text };
}

/**
 * The arguments of a call from the values of the form.
 * @param {Field[]} fields
 * @param {Record<string, string | boolean | undefined>} values by field name
 * @returns {{ args: Record<string, unknown>, errors: Record<string, string> }}
 */
export function buildArguments(fields, values) {
  /** @type {Record<string, unknown>} */
  const args = {};
  /** @type {Record<string, string>} */
  const errors = {};
  for (const field of fields) {
    const result = coerceValue(field, values[field.name]);
    if (!result.ok) errors[field.name] = result.message;
    else if (!result.omit) args[field.name] = result.value;
  }
  return { args, errors };
}

/**
 * The initial values of the form: the schema default, else nothing.
 * @param {Field[]} fields
 * @returns {Record<string, string | boolean>}
 */
export function initialValues(fields) {
  /** @type {Record<string, string | boolean>} */
  const values = {};
  for (const f of fields) {
    if (f.defaultValue === undefined) values[f.name] = f.kind === 'boolean' ? false : '';
    else if (f.kind === 'boolean') values[f.name] = f.defaultValue === true;
    else values[f.name] = typeof f.defaultValue === 'string' ? f.defaultValue : JSON.stringify(f.defaultValue);
  }
  return values;
}

/**
 * The timeout field: whole milliseconds from 1 to 600000, or nothing.
 * @param {string} text
 * @returns {{ ok: true, value?: number } | { ok: false, message: string }}
 */
export function parseTimeout(text) {
  const t = text.trim();
  if (t === '') return { ok: true };
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 600000) return { ok: false, message: 'Enter whole milliseconds from 1 to 600000.' };
  return { ok: true, value: n };
}

/** Text of a duration for a badge: 0.4 s, 12 s. @param {number} ms */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}
