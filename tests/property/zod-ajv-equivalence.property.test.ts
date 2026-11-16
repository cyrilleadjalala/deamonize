// Feature: daemonize, Property 10: generated Zod accepts iff AJV accepts
// Validates: Requirements 11.6, 11.8
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { jsonSchemaToZodSource } from '../../src/compiler/zod-translator.js';
import { invalidPayloadArbitrary, schemaArbitrary } from '../../src/pbt/schema-arbitrary.js';
import { Validator } from '../../src/validator/validator.js';

type Schema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The two validators under comparison
// ---------------------------------------------------------------------------

function zodFor(schema: Schema): z.ZodType {
  return new Function('z', 'return ' + jsonSchemaToZodSource(schema))(z) as z.ZodType;
}

/** AJV exactly as the production Validator configures it (Ajv2020, allErrors, ajv-formats). */
function ajvFor(schema: Schema): (payload: unknown) => boolean {
  const validator = new Validator(new Map([['t', schema]]));
  return (payload) => validator.validate('t', payload) === null;
}

// ---------------------------------------------------------------------------
// Schema generator (supported subset), written with fast-check only
// ---------------------------------------------------------------------------

const NAMES = ['a', 'b', 'c', 'd'];
const PATTERNS = ['^[a-z]+$', '^\\d{2,4}$', '^[A-Z][a-z]*$', 'abc', '^.{2}$'];

const small = fc.integer({ min: 0, max: 8 });
const bound = fc.integer({ min: -50, max: 50 });

const stringSchema: fc.Arbitrary<Schema> = fc.oneof(
  fc.record({ type: fc.constant('string') }),
  fc
    .tuple(fc.option(small, { nil: undefined }), fc.option(small, { nil: undefined }))
    .map(([x, y]) => {
      const [minLength, maxLength] =
        x !== undefined && y !== undefined ? [Math.min(x, y), Math.max(x, y)] : [x, y];
      const s: Schema = { type: 'string' };
      if (minLength !== undefined) s['minLength'] = minLength;
      if (maxLength !== undefined) s['maxLength'] = maxLength;
      return s;
    }),
  fc.constantFrom(...PATTERNS).map((pattern) => ({ type: 'string', pattern })),
  fc.constantFrom('email', 'uuid', 'date-time').map((format) => ({ type: 'string', format }))
);

const numberSchema: fc.Arbitrary<Schema> = fc
  .tuple(
    fc.constantFrom('integer', 'number'),
    fc.option(bound, { nil: undefined }),
    fc.option(bound, { nil: undefined })
  )
  .map(([type, x, y]) => {
    const [minimum, maximum] = x !== undefined && y !== undefined ? [Math.min(x, y), Math.max(x, y)] : [x, y];
    const s: Schema = { type };
    if (minimum !== undefined) s['minimum'] = minimum;
    if (maximum !== undefined) s['maximum'] = maximum;
    return s;
  });

const primitive = fc.oneof(fc.string({ maxLength: 4 }), fc.integer({ min: -5, max: 5 }), fc.boolean(), fc.constant(null));

const leafSchema: fc.Arbitrary<Schema> = fc.oneof(
  { weight: 4, arbitrary: stringSchema },
  { weight: 3, arbitrary: numberSchema },
  fc.constant<Schema>({ type: 'boolean' }),
  fc.constant<Schema>({ type: 'null' }),
  fc.array(primitive, { minLength: 1, maxLength: 4 }).map((values) => ({ enum: values })),
  primitive.map((value) => ({ const: value })),
  fc
    .uniqueArray(fc.constantFrom('string', 'integer', 'number', 'boolean', 'null'), { minLength: 2, maxLength: 3 })
    .map((type) => ({ type }))
);

function schemaOfDepth(depth: number): fc.Arbitrary<Schema> {
  if (depth === 0) return leafSchema;
  const child = schemaOfDepth(depth - 1);

  const array = fc
    .tuple(
      child,
      fc.option(small, { nil: undefined }),
      fc.option(small, { nil: undefined }),
      fc.boolean()
    )
    .map(([items, x, y, unique]) => {
      const [minItems, maxItems] = x !== undefined && y !== undefined ? [Math.min(x, y), Math.max(x, y)] : [x, y];
      const s: Schema = { type: 'array', items };
      // uniqueItems cannot be generated above one item for a one-value item schema (e.g. null), so cap minItems
      if (minItems !== undefined) s['minItems'] = unique ? Math.min(minItems, 1) : minItems;
      if (maxItems !== undefined) s['maxItems'] = unique ? Math.max(maxItems, Math.min(minItems ?? 0, 1)) : maxItems;
      if (unique) s['uniqueItems'] = true;
      return s;
    });

  const object = fc
    .tuple(
      fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 0, maxLength: 4 }),
      fc.array(child, { minLength: 4, maxLength: 4 }),
      fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      fc.constantFrom<boolean | undefined>(true, false, undefined)
    )
    .map(([names, children, isRequired, additionalProperties]) => {
      const properties: Record<string, Schema> = {};
      names.forEach((name, i) => (properties[name] = children[i]));
      const s: Schema = { type: 'object', properties };
      const required = names.filter((_, i) => isRequired[i]);
      if (required.length > 0) s['required'] = required;
      if (additionalProperties !== undefined) s['additionalProperties'] = additionalProperties;
      return s;
    });

  const anyOf = fc.array(child, { minLength: 2, maxLength: 3 }).map((branches) => ({ anyOf: branches }));

  return fc.oneof({ weight: 2, arbitrary: leafSchema }, array, { weight: 2, arbitrary: object }, anyOf);
}

const schemaArb: fc.Arbitrary<Schema> = fc.integer({ min: 0, max: 3 }).chain(schemaOfDepth);

// ---------------------------------------------------------------------------
// Payload generators
// ---------------------------------------------------------------------------

type Mutation =
  | { kind: 'flip' | 'drop' | 'addKey' | 'plus' | 'minus' | 'empty' | 'huge' | 'dup' }
  | { kind: 'astral'; count: number };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.constantFrom<Mutation>(
    { kind: 'flip' }, { kind: 'drop' }, { kind: 'addKey' }, { kind: 'plus' }, { kind: 'minus' },
    { kind: 'empty' }, { kind: 'huge' }, { kind: 'dup' }
  ),
  fc.integer({ min: 1, max: 6 }).map<Mutation>((count) => ({ kind: 'astral', count }))
);

function mutateNode(node: unknown, mutation: Mutation, pick: number): unknown {
  switch (mutation.kind) {
    case 'flip':
      if (typeof node === 'string') return 0;
      if (typeof node === 'number') return String(node);
      if (typeof node === 'boolean') return String(node);
      if (node === null) return 0;
      return Array.isArray(node) ? {} : [];
    case 'drop': {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return node;
      const keys = Object.keys(node);
      if (keys.length === 0) return node;
      const { [keys[pick % keys.length]]: _removed, ...rest } = node as Record<string, unknown>;
      return rest;
    }
    case 'addKey':
      return typeof node === 'object' && node !== null && !Array.isArray(node) ? { ...node, __extra__: 1 } : node;
    case 'plus':
      return typeof node === 'number' ? node + 1 : node;
    case 'minus':
      return typeof node === 'number' ? node - 1 : node;
    case 'empty':
      return '';
    case 'astral':
      return '\u{1F600}'.repeat(mutation.count);
    case 'huge':
      return new Array(60).fill(Array.isArray(node) && node.length > 0 ? node[0] : null);
    case 'dup':
      return Array.isArray(node) && node.length > 0 ? [...node, node[0]] : node;
  }
}

/** Apply a mutation at the node designated by `target` (index into a pre-order walk of the payload). */
function mutateAt(payload: unknown, target: number, mutation: Mutation, pick: number): unknown {
  let counter = 0;
  const walk = (node: unknown): unknown => {
    if (counter++ === target) return mutateNode(node, mutation, pick);
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(payload);
}

function payloadArb(schema: Schema): fc.Arbitrary<unknown> {
  const valid = schemaArbitrary(schema);
  let invalid: fc.Arbitrary<unknown>;
  try {
    invalid = invalidPayloadArbitrary(schema);
  } catch {
    invalid = valid; // no invalid value can be built for this schema (e.g. an unconstrained one)
  }
  const mutated = fc
    .tuple(valid, fc.nat(30), mutationArb, fc.nat(10))
    .map(([payload, target, mutation, pick]) => mutateAt(payload, target, mutation, pick));
  // Strings in the generated payloads include non-BMP characters so code point vs UTF-16 counting is exercised
  return fc.oneof(
    { weight: 3, arbitrary: valid },
    { weight: 3, arbitrary: invalid },
    { weight: 4, arbitrary: mutated },
    { weight: 1, arbitrary: fc.jsonValue() },
    { weight: 1, arbitrary: fc.fullUnicodeString({ maxLength: 8 }) },
    { weight: 1, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true }) }
  );
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const RUNS = 300;

describe('Property 10: generated Zod accepts iff AJV accepts', () => {
  // AJV strict mode logs "use allowUnionTypes" for every type list; the Validator keeps that default, so only mute the log
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('agrees with AJV on valid, invalid, mutated and arbitrary payloads of random schemas', () => {
    fc.assert(
      fc.property(
        schemaArb.chain((schema) => fc.tuple(fc.constant(schema), fc.array(payloadArb(schema), { minLength: 4, maxLength: 8 }))),
        ([schema, payloads]) => {
          const zod = zodFor(schema);
          const ajv = ajvFor(schema);
          for (const payload of payloads) {
            const expected = ajv(payload);
            const actual = zod.safeParse(payload).success;
            if (actual !== expected) {
              throw new Error(
                `Zod ${actual} but AJV ${expected}\nschema: ${JSON.stringify(schema)}\npayload: ${JSON.stringify(payload)}\nzod: ${jsonSchemaToZodSource(schema)}`
              );
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  }, 120_000);

  it('agrees with AJV on boundary strings, integers and formats (UTF-16 vs code points, unsafe integers, urn:uuid)', () => {
    const edge = fc.constantFrom<unknown>(
      '', '\u{1F600}', '\u{1F600}\u{1F600}', 'ab', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000',
      '123e4567-e89b-12d3-a456-426614174000', '123E4567-E89B-12D3-A456-426614174000', '00000000-0000-0000-0000-000000000000',
      '2024-01-02T03:04:05Z', '2024-01-02t03:04:05z', '2024-01-02T03:04:05.123+02:00', '2024-02-30T03:04:05Z', '2024-01-02T24:00:00Z',
      '2024-01-02T03:04:05', '2024-01-02 03:04:05Z', '2016-12-31T23:59:60Z', 'a@b', 'a@b.c', 'a.b@c.de', 'a@b..c', '"a b"@c.de', 'a@[1.2.3.4]',
      '\u00e9@example.com', 'a@\u00e9.com', ' a@b.com',
      1, 1.5, 2 ** 53, 2 ** 53 + 2, 1e21, -1e21, 1e300, -0, 0.1, 9007199254740993, Number.MAX_VALUE, Number.MIN_VALUE
    );
    const schemas: Schema[] = [
      { type: 'string', minLength: 1 },
      { type: 'string', maxLength: 1 },
      { type: 'string', minLength: 2, maxLength: 2 },
      { type: 'string', format: 'uuid' },
      { type: 'string', format: 'date-time' },
      { type: 'string', format: 'email' },
      { type: 'integer' },
      { type: 'integer', minimum: 0 },
      { type: 'number', maximum: 10 },
      { type: ['integer', 'null'] },
      { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 1 }] },
    ];
    const compiled = schemas.map((schema) => ({ schema, zod: zodFor(schema), ajv: ajvFor(schema) }));
    fc.assert(
      fc.property(edge, (payload) => {
        for (const { schema, zod, ajv } of compiled) {
          const expected = ajv(payload);
          const actual = zod.safeParse(payload).success;
          if (actual !== expected) {
            throw new Error(`Zod ${actual} but AJV ${expected}\nschema: ${JSON.stringify(schema)}\npayload: ${JSON.stringify(payload)}`);
          }
        }
      }),
      { numRuns: 200 }
    );
    expect(compiled.length).toBe(schemas.length);
  });
});
