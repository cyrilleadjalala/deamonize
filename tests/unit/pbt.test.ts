import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  UnsupportedSchemaError,
  findUnsupported,
  invalidPayloadArbitrary,
  schemaArbitrary,
} from '../../src/pbt/schema-arbitrary.js';
import { checkProperty, getReports, printReport } from '../../src/pbt/property-runner.js';
import { PbtGenerator } from '../../src/pbt/pbt-generator.js';
import { SchemaInferencer } from '../../src/schema/schema-inferencer.js';
import type { WorkflowSet } from '../../src/types.js';
import { removeDir } from '../helpers/cleanup.js';

const schemas: Record<string, Record<string, unknown>> = {
  'bounds and required': {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 10 },
      qty: { type: 'integer', minimum: 1, maximum: 50 },
      price: { type: 'number', minimum: 0 },
    },
    required: ['name', 'qty'],
    additionalProperties: false,
  },
  'formats, enum and alternatives': {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      id: { type: 'string', format: 'uuid' },
      at: { type: 'string', format: 'date-time' },
      plan: { enum: ['free', 'pro'] },
      code: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      tags: { type: 'array', items: { type: 'string' } },
      vip: { type: 'boolean' },
    },
    required: ['email', 'plan', 'code'],
  },
  'no properties at all': { type: 'object' },
  'pattern, constant, bounded unique arrays': {
    type: 'object',
    properties: {
      sku: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{2}$' },
      kind: { const: 'order' },
      tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 3, uniqueItems: true },
    },
    required: ['sku', 'kind', 'tags'],
  },
  'oneOf with distinct types and type lists': {
    type: 'object',
    properties: {
      value: { oneOf: [{ type: 'string' }, { type: 'boolean' }] },
      note: { type: ['string', 'null'] },
    },
    required: ['value', 'note'],
  },
  'allOf of object schemas': {
    allOf: [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'integer', minimum: 0 } }, required: ['b'] },
    ],
  },
  'a required field without a schema': {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name', 'extra'],
  },
};

describe('schemaArbitrary and invalidPayloadArbitrary', () => {
  for (const [name, schema] of Object.entries(schemas)) {
    it(`every generated valid payload satisfies the schema (${name})`, async () => {
      const check = await compileWithFormats(schema);
      fc.assert(fc.property(schemaArbitrary(schema), (payload) => check(payload) === true), { numRuns: 200 });
    });

    it(`every generated invalid payload breaks the schema (${name})`, async () => {
      const check = await compileWithFormats(schema);
      fc.assert(fc.property(invalidPayloadArbitrary(schema), (payload) => check(payload) === false), {
        numRuns: 300,
      });
    });
  }

  it('covers the different kinds of violations', () => {
    const seen = new Set<string>();
    const schema = schemas['bounds and required'];

    fc.assert(
      fc.property(invalidPayloadArbitrary(schema), (payload) => {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) seen.add('not_an_object');
        else {
          const record = payload as Record<string, unknown>;
          if (!('name' in record)) seen.add('missing');
          if ('__unexpected_field__' in record) seen.add('extra');
          if (typeof record['qty'] === 'number' && (record['qty'] < 1 || record['qty'] > 50)) seen.add('out_of_range');
          if (typeof record['qty'] === 'string') seen.add('wrong_type');
        }
      }),
      { numRuns: 500 }
    );

    expect([...seen].sort()).toEqual(['extra', 'missing', 'not_an_object', 'out_of_range', 'wrong_type']);
  });

  async function compileWithFormats(schema: Record<string, unknown>) {
    const { default: addFormats } = (await import('ajv-formats')) as unknown as {
      default: (instance: Ajv2020) => void;
    };
    const instance = new Ajv2020({ allErrors: true, strict: false });
    addFormats(instance);
    return instance.compile(schema);
  }
});

describe('findUnsupported', () => {
  const unsupported: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a keyword it cannot constrain', { type: 'object', properties: { q: { type: 'integer', multipleOf: 5 } } }, /properties\.q: keyword "multipleOf"/],
    ['a $ref', { type: 'object', properties: { a: { $ref: '#/$defs/x' } } }, /keyword "\$ref"/],
    ['not', { type: 'object', properties: { a: { not: { type: 'string' } } } }, /keyword "not"/],
    ['a format it cannot generate', { type: 'object', properties: { u: { type: 'string', format: 'uri' } } }, /format "uri"/],
    ['oneOf branches that can overlap', { type: 'object', properties: { n: { oneOf: [{ type: 'number' }, { type: 'integer' }] } } }, /oneOf/],
    ['allOf with additionalProperties false', { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }], additionalProperties: false }, /allOf/],
    ['a field defined twice in allOf', { allOf: [{ properties: { a: { type: 'string' } } }, { properties: { a: { type: 'integer' } } }] }, /"a" is defined twice/],
    ['tuple items', { type: 'array', items: [{ type: 'string' }] }, /items must be a single schema/],
    ['a schema in additionalProperties', { type: 'object', additionalProperties: { type: 'string' } }, /additionalProperties must be true or false/],
    ['a constraint next to anyOf', { type: 'object', properties: { a: { type: 'string', anyOf: [{ type: 'string' }] } } }, /"type" next to "anyOf"/],
    ['a required field that cannot exist', { type: 'object', additionalProperties: false, required: ['x'] }, /required field is missing/],
  ];

  for (const [name, schema, reason] of unsupported) {
    it(`names the problem for ${name}`, () => {
      expect(findUnsupported(schema)).toMatch(reason);
    });

    it(`refuses to generate values for ${name}`, () => {
      expect(() => schemaArbitrary(schema)).toThrow(UnsupportedSchemaError);
      expect(() => invalidPayloadArbitrary(schema)).toThrow(UnsupportedSchemaError);
    });
  }

  it('accepts every schema the inference produces', () => {
    const set: WorkflowSet = {
      version: '1',
      targetType: 'web',
      targetName: 'CRM',
      startUrl: 'http://localhost/',
      workflows: [
        {
          id: '12121212-1212-4212-8212-121212121212',
          label: 'Create customer',
          steps: [{ actionType: 'type', selectors: ['#a'], variable: 'email' }],
          variables: [{ name: 'email', description: 'E-mail' }, { name: 'code' }, { name: 'vip', type: 'boolean', optional: true }],
          observedPayloads: [
            { email: 'a@example.com', code: 'x', tags: ['a'], nested: { n: 1 } },
            { email: 'b@example.com', code: 3, tags: [], nested: { n: 2.5 } },
          ],
        },
      ],
    };

    const [workflow] = new SchemaInferencer().inferWorkflows(set).workflows;
    expect(workflow.inputSchema).toBeDefined();
    expect(findUnsupported(workflow.inputSchema!)).toBeNull();
    expect(() => schemaArbitrary(workflow.inputSchema!)).not.toThrow();
  });
});

describe('property runner', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records a passing property', () => {
    const report = checkProperty('always true', fc.property(fc.integer(), () => true), 20);

    expect(report).toMatchObject({ name: 'always true', passed: true, runs: 20 });
  });

  it('fails with the shrunk counterexample and reports it', () => {
    const before = getReports().length;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => checkProperty('below ten', fc.property(fc.integer(), (n) => n < 10))).toThrow(
      /Counterexample: 10/
    );

    const failing = getReports().slice(before);
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ name: 'below ten', passed: false, counterexample: '10' });

    printReport('demo');
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('failing');
    expect(printed).toContain('below ten: shrunk counterexample 10');
  });
});

describe('PbtGenerator', () => {
  const set: WorkflowSet = {
    version: '1',
    targetType: 'web',
    targetName: 'CRM',
    startUrl: 'http://localhost/',
    workflows: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        label: 'Create customer',
        steps: [{ actionType: 'type', selectors: ['#email'], variable: 'email' }],
        variables: [{ name: 'email' }],
        observedPayloads: [{ email: 'a@example.com' }],
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        label: 'Create customer',
        steps: [{ actionType: 'click', selectors: ['#go'] }],
        variables: [],
        observedPayloads: [],
      },
    ],
  };

  it('writes one self-contained test file per action, plus the support modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-pbt-'));
    try {
      const annotated = new SchemaInferencer().inferWorkflows(set);
      const toolNames = new Map([
        [set.workflows[0].id, 'create_customer'],
        [set.workflows[1].id, 'create_customer_2'],
      ]);

      const { files: written, skipped } = await new PbtGenerator().generate(annotated, toolNames, dir);

      expect((await readdir(join(dir, 'tests'))).sort()).toEqual([
        'create_customer.property.test.ts',
        'create_customer_2.property.test.ts',
        'property-runner.ts',
        'schema-arbitrary.ts',
      ]);
      expect(written).toHaveLength(4);
      expect(skipped).toEqual([]);

      const source = await readFile(join(dir, 'tests', 'create_customer.property.test.ts'), 'utf-8');
      expect(source).toContain('"format": "email"');
      expect(source).toContain('Property 7');
      expect(source).toContain('Property 8');
      // Self-contained: nothing is imported from Daemonize
      expect(source).not.toMatch(/from "(\.\.\/)+src/);
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      expect(imports).toEqual([
        'vitest',
        'fast-check',
        'ajv/dist/2020.js',
        'ajv-formats',
        './schema-arbitrary.js',
        './property-runner.js',
      ]);
    } finally {
      await removeDir(dir);
    }
  });

  it('writes explicitly skipped tests, and reports why, for a schema it cannot generate values for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemonize-pbt-'));
    try {
      const annotated = new SchemaInferencer().inferWorkflows(set);
      annotated.workflows[0].inputSchema = {
        type: 'object',
        properties: { qty: { type: 'integer', multipleOf: 5 } },
      };
      const toolNames = new Map([
        [set.workflows[0].id, 'create_customer'],
        [set.workflows[1].id, 'create_customer_2'],
      ]);

      const { skipped } = await new PbtGenerator().generate(annotated, toolNames, dir);

      expect(skipped).toHaveLength(1);
      expect(skipped[0].tool).toBe('create_customer');
      expect(skipped[0].reason).toMatch(/multipleOf/);

      const source = await readFile(join(dir, 'tests', 'create_customer.property.test.ts'), 'utf-8');
      expect(source).toContain('it.skip(');
      expect(source).toContain('multipleOf');
      expect(source).not.toContain('checkProperty');
    } finally {
      await removeDir(dir);
    }
  });
});

