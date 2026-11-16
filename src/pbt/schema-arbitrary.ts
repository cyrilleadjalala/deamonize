import fc from 'fast-check';

type Schema = Record<string, unknown>;

/*
 * Test support copied verbatim next to every generated property-based test
 * suite, so it must stay self-contained: it imports nothing but fast-check.
 *
 * json-schema-fast-check is not used: it bundles fast-check 1.x, whose
 * arbitraries cannot be combined with the fast-check 3 used by this project.
 *
 * Only a documented subset of JSON Schema is supported. Anything else is
 * refused with an UnsupportedSchemaError instead of generating values that
 * ignore the keyword, which would make a property pass without proving anything.
 */

/** Raised for a schema, or a keyword of a schema, this module cannot generate values for. */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

// Keywords that only describe the schema and never constrain a value
const ANNOTATIONS = [
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
];

// Keywords this module turns into constraints on generated values
const CONSTRAINTS = [
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'allOf',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'format',
];

const SUPPORTED_FORMATS = ['email', 'uuid', 'date-time'];
const SUPPORTED_TYPES = ['string', 'integer', 'number', 'boolean', 'null', 'array', 'object'];

/**
 * Explain why a schema is not supported, or return null when it is. The
 * message names the keyword and where it is, for example
 * `properties.qty: keyword "multipleOf" is not supported`.
 */
export function findUnsupported(schema: Schema, path = '#'): string | null {
  const fail = (reason: string): string => `${path}: ${reason}`;

  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATIONS.includes(keyword) && !CONSTRAINTS.includes(keyword)) {
      return fail(`keyword "${keyword}" is not supported`);
    }
  }

  const type = schema['type'];
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    const unknown = types.find((t) => !SUPPORTED_TYPES.includes(t as string));
    if (unknown !== undefined) {
      return fail(`type "${String(unknown)}" is not supported`);
    }
  }

  if (schema['format'] !== undefined && !SUPPORTED_FORMATS.includes(schema['format'] as string)) {
    return fail(`format "${String(schema['format'])}" is not supported`);
  }

  if (schema['pattern'] !== undefined) {
    try {
      fc.stringMatching(new RegExp(schema['pattern'] as string));
    } catch {
      return fail(`pattern "${String(schema['pattern'])}" cannot be turned into values`);
    }
  }

  if (schema['additionalProperties'] !== undefined && typeof schema['additionalProperties'] !== 'boolean') {
    return fail('additionalProperties must be true or false');
  }

  // A combinator replaces the other constraints, so they cannot be mixed
  const combinators = ['anyOf', 'oneOf', 'allOf'].filter((keyword) => schema[keyword] !== undefined);
  if (combinators.length > 1) {
    return fail(`"${combinators.join('" and "')}" cannot be combined`);
  }
  if (combinators.length === 1 && combinators[0] !== 'allOf') {
    const sibling = CONSTRAINTS.find((keyword) => keyword !== combinators[0] && schema[keyword] !== undefined);
    if (sibling !== undefined) {
      return fail(`"${sibling}" next to "${combinators[0]}" is not supported`);
    }
  }

  if (Array.isArray(schema['oneOf']) && !branchesAreExclusive(schema['oneOf'] as Schema[])) {
    return fail('"oneOf" is only supported when its branches cannot match the same value (distinct types or constants)');
  }

  if (Array.isArray(schema['allOf'])) {
    const reason = findUnmergeableAllOf(schema);
    if (reason !== null) {
      return fail(reason);
    }
  }

  if (schema['items'] !== undefined && (typeof schema['items'] !== 'object' || Array.isArray(schema['items']))) {
    return fail('items must be a single schema');
  }

  const required = (Array.isArray(schema['required']) ? schema['required'] : []) as string[];
  const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
  if (schema['additionalProperties'] === false && required.some((name) => !(name in properties))) {
    return fail('a required field is missing from properties while additional properties are forbidden');
  }

  // Sub-schemas
  for (const [name, child] of Object.entries(properties)) {
    const reason = findUnsupported(child, path === '#' ? `properties.${name}` : `${path}.properties.${name}`);
    if (reason !== null) return reason;
  }
  if (schema['items'] !== undefined) {
    const reason = findUnsupported(schema['items'] as Schema, `${path}.items`);
    if (reason !== null) return reason;
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const [index, branch] of (branches as Schema[]).entries()) {
        const reason = findUnsupported(branch, `${path}.${keyword}[${index}]`);
        if (reason !== null) return reason;
      }
    }
  }

  return null;
}

/**
 * Build a fast-check arbitrary producing values that satisfy a JSON Schema.
 * Throws an UnsupportedSchemaError for anything outside the supported subset.
 */
export function schemaArbitrary(schema: Schema): fc.Arbitrary<unknown> {
  assertSupported(schema);
  return build(schema);
}

/**
 * Build a fast-check arbitrary producing payloads that each break at least one
 * constraint of a schema: not an object, a required field missing, a field of
 * the wrong type, a value out of bounds, outside its enum or constant, too
 * short/long, not matching its pattern, a malformed email/uuid/date-time, a
 * duplicated item, or an unexpected field when the schema forbids them. Every
 * mutation is chosen so the payload cannot satisfy the schema.
 */
export function invalidPayloadArbitrary(schema: Schema): fc.Arbitrary<unknown> {
  assertSupported(schema);
  const resolved = resolveAllOf(schema);

  if (resolved['type'] !== 'object') {
    const values = invalidValues(resolved);
    if (values.length === 0) {
      throw new UnsupportedSchemaError('#: no invalid value can be built for this schema');
    }
    return fc.constantFrom(...values);
  }

  const mutations: fc.Arbitrary<unknown>[] = [fc.constantFrom<unknown>('text', 42, true, null, [])];
  const valid = build(resolved) as fc.Arbitrary<Record<string, unknown>>;
  const properties = (resolved['properties'] ?? {}) as Record<string, Schema>;
  const required = (Array.isArray(resolved['required']) ? resolved['required'] : []) as string[];

  for (const name of required) {
    mutations.push(
      valid.map((payload) => {
        const { [name]: _removed, ...rest } = payload;
        return rest;
      })
    );
  }

  for (const [name, property] of Object.entries(properties)) {
    const replacements = invalidValues(resolveAllOf(property));
    if (replacements.length > 0) {
      mutations.push(
        fc
          .tuple(valid, fc.constantFrom(...replacements))
          .map(([payload, value]) => ({ ...payload, [name]: value }))
      );
    }
  }

  if (resolved['additionalProperties'] === false) {
    mutations.push(valid.map((payload) => ({ ...payload, __unexpected_field__: true })));
  }

  return fc.oneof(...mutations);
}

function assertSupported(schema: Schema): void {
  const reason = findUnsupported(schema);
  if (reason !== null) {
    throw new UnsupportedSchemaError(reason);
  }
}

// ---------------------------------------------------------------------------
// Valid values
// ---------------------------------------------------------------------------

function build(schema: Schema): fc.Arbitrary<unknown> {
  const resolved = resolveAllOf(schema);

  if (resolved['const'] !== undefined) {
    return fc.constant(resolved['const']);
  }
  if (Array.isArray(resolved['enum'])) {
    return fc.constantFrom(...(resolved['enum'] as unknown[]));
  }
  if (Array.isArray(resolved['anyOf'])) {
    return fc.oneof(...(resolved['anyOf'] as Schema[]).map(build));
  }
  if (Array.isArray(resolved['oneOf'])) {
    return fc.oneof(...(resolved['oneOf'] as Schema[]).map(build));
  }

  const type = resolved['type'];
  if (Array.isArray(type)) {
    return fc.oneof(...type.map((t) => build({ ...resolved, type: t })));
  }

  switch (type) {
    case 'string':
      return stringArbitrary(resolved);
    case 'integer':
      return fc.integer({
        min: (resolved['minimum'] as number | undefined) ?? -100000,
        max: (resolved['maximum'] as number | undefined) ?? 100000,
      });
    case 'number':
      return fc.double({
        min: (resolved['minimum'] as number | undefined) ?? -100000,
        max: (resolved['maximum'] as number | undefined) ?? 100000,
        noNaN: true,
        noDefaultInfinity: true,
      });
    case 'boolean':
      return fc.boolean();
    case 'null':
      return fc.constant(null);
    case 'array':
      return arrayArbitrary(resolved);
    case 'object':
      return objectArbitrary(resolved);
    default:
      return fc.jsonValue();
  }
}

function stringArbitrary(schema: Schema): fc.Arbitrary<string> {
  const minLength = (schema['minLength'] as number | undefined) ?? 0;
  const maxLength = (schema['maxLength'] as number | undefined) ?? 20;

  if (schema['pattern'] !== undefined) {
    return fc
      .stringMatching(new RegExp(schema['pattern'] as string))
      .filter((value) => value.length >= minLength && value.length <= maxLength);
  }

  switch (schema['format']) {
    case 'email':
      return fc.stringMatching(/^[a-z]{1,8}$/).map((local) => `${local}@example.com`);
    case 'uuid':
      return fc.uuid();
    case 'date-time':
      return fc
        .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true })
        .map((date) => date.toISOString());
    default:
      return fc.string({ minLength, maxLength });
  }
}

function arrayArbitrary(schema: Schema): fc.Arbitrary<unknown[]> {
  const items = build((schema['items'] as Schema | undefined) ?? {});
  const minLength = (schema['minItems'] as number | undefined) ?? 0;
  const maxLength = (schema['maxItems'] as number | undefined) ?? Math.max(minLength, 5);

  if (schema['uniqueItems'] === true) {
    return fc.uniqueArray(items, { minLength, maxLength, selector: (value) => JSON.stringify(value) });
  }
  return fc.array(items, { minLength, maxLength });
}

function objectArbitrary(schema: Schema): fc.Arbitrary<Record<string, unknown>> {
  const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
  const required = (Array.isArray(schema['required']) ? schema['required'] : []) as string[];

  const model: Record<string, fc.Arbitrary<unknown>> = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    model[name] = build(propertySchema);
  }
  // A required field with no schema accepts any value
  for (const name of required) {
    model[name] ??= fc.jsonValue();
  }
  return fc.record(model, { requiredKeys: required });
}

// ---------------------------------------------------------------------------
// allOf
// ---------------------------------------------------------------------------

/** allOf is supported for object schemas that only add properties and required fields. */
function findUnmergeableAllOf(schema: Schema): string | null {
  const seen = new Set<string>(Object.keys((schema['properties'] ?? {}) as Schema));
  for (const [index, branch] of (schema['allOf'] as Schema[]).entries()) {
    const where = `allOf[${index}]`;
    if (branch['type'] !== undefined && branch['type'] !== 'object') {
      return `${where} must be an object schema`;
    }
    if (branch['additionalProperties'] === false || schema['additionalProperties'] === false) {
      return `"additionalProperties": false cannot be combined with "allOf"`;
    }
    const other = Object.keys(branch).find(
      (keyword) => !ANNOTATIONS.includes(keyword) && !['type', 'properties', 'required', 'additionalProperties'].includes(keyword)
    );
    if (other !== undefined) {
      return `${where} uses "${other}", only properties and required are supported in allOf`;
    }
    for (const name of Object.keys((branch['properties'] ?? {}) as Schema)) {
      if (seen.has(name)) {
        return `field "${name}" is defined twice in allOf`;
      }
      seen.add(name);
    }
  }
  return null;
}

/** Merge the branches of an allOf into a single object schema. */
function resolveAllOf(schema: Schema): Schema {
  if (!Array.isArray(schema['allOf'])) {
    return schema;
  }

  const { allOf, ...rest } = schema;
  const properties: Record<string, Schema> = { ...((rest['properties'] ?? {}) as Record<string, Schema>) };
  const required = new Set<string>((Array.isArray(rest['required']) ? rest['required'] : []) as string[]);

  for (const branch of allOf as Schema[]) {
    Object.assign(properties, (branch['properties'] ?? {}) as Record<string, Schema>);
    for (const name of (Array.isArray(branch['required']) ? branch['required'] : []) as string[]) {
      required.add(name);
    }
  }

  return { ...rest, type: 'object', properties, required: [...required] };
}

/** oneOf matches exactly one branch: only safe to generate when branches cannot overlap. */
function branchesAreExclusive(branches: Schema[]): boolean {
  const typed = branches.every((branch) => typeof branch['type'] === 'string');
  if (typed) {
    // integer is a kind of number, so both together overlap
    const types = branches.map((branch) => branch['type'] as string);
    const kinds = new Set(types);
    return kinds.size === types.length && !(kinds.has('integer') && kinds.has('number'));
  }

  const constants = branches.every((branch) => branch['const'] !== undefined);
  if (constants) {
    const values = branches.map((branch) => JSON.stringify(branch['const']));
    return new Set(values).size === values.length;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Invalid values
// ---------------------------------------------------------------------------

type JsonKind = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';

// One value per JSON kind; 1.5 is a number that is not an integer
const SAMPLE_BY_KIND: Array<[JsonKind[], unknown]> = [
  [['string'], 'text'],
  [['number'], 1.5],
  [['boolean'], true],
  [['null'], null],
  [['array'], []],
  [['object'], {}],
];

/** JSON kinds a property schema accepts, or null when that cannot be told. */
function acceptedKinds(property: Schema): Set<string> | null {
  if (Array.isArray(property['enum']) || property['const'] !== undefined) {
    return null;
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    const branches = property[keyword];
    if (Array.isArray(branches)) {
      const accepted = new Set<string>();
      for (const branch of branches as Schema[]) {
        const kinds = acceptedKinds(resolveAllOf(branch));
        if (kinds === null) {
          return null;
        }
        kinds.forEach((kind) => accepted.add(kind));
      }
      return accepted;
    }
  }

  const type = property['type'];
  const types = (Array.isArray(type) ? type : type === undefined ? [] : [type]) as string[];
  if (types.length === 0) {
    return null;
  }
  const accepted = new Set(types);
  if (accepted.has('number')) {
    accepted.add('integer');
  }
  return accepted;
}

/** Values that cannot satisfy a property schema. */
function invalidValues(property: Schema): unknown[] {
  const values: unknown[] = [];

  const accepted = acceptedKinds(property);
  if (accepted !== null) {
    for (const [kinds, sample] of SAMPLE_BY_KIND) {
      // 1.5 is accepted by "number" only; every other sample matches its own kind
      if (!kinds.some((kind) => accepted.has(kind))) {
        values.push(sample);
      }
    }
  }

  if (property['const'] !== undefined) {
    values.push({ __not_the_constant__: true });
  }
  if (Array.isArray(property['enum'])) {
    values.push('__not_in_enum__');
  }
  if (typeof property['minimum'] === 'number') {
    values.push(property['minimum'] - 1);
  }
  if (typeof property['maximum'] === 'number') {
    values.push(property['maximum'] + 1);
  }
  if (typeof property['minLength'] === 'number' && property['minLength'] > 0) {
    values.push('');
  }
  if (typeof property['maxLength'] === 'number') {
    values.push('x'.repeat(property['maxLength'] + 1));
  }
  if (typeof property['pattern'] === 'string') {
    const pattern = new RegExp(property['pattern']);
    values.push(...['', '!', '###', 'zzzzzzzz', '0'].filter((candidate) => !pattern.test(candidate)));
  }
  if (SUPPORTED_FORMATS.includes(property['format'] as string)) {
    values.push('not-a-valid-value');
  }
  if (typeof property['minItems'] === 'number' && property['minItems'] > 0) {
    values.push([]);
  }
  if (typeof property['maxItems'] === 'number') {
    values.push(new Array(property['maxItems'] + 1).fill(null));
  }
  if (property['uniqueItems'] === true) {
    values.push([1, 1]);
  }

  return values;
}
