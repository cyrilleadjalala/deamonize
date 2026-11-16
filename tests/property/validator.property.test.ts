import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { schemaArbitrary } from '../../src/pbt/schema-arbitrary.js';
import { Validator } from '../../src/validator/validator.js';

// An input schema of the shape the SchemaInferencer produces
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    qty: { type: 'integer', minimum: 0, maximum: 1000 },
    vip: { type: 'boolean' },
  },
  required: ['name', 'qty'],
  additionalProperties: false,
};

const validator = new Validator(new Map([['create_customer', schema]]));

// Payloads that satisfy the schema, derived from the schema itself
const validPayloads = schemaArbitrary(schema) as fc.Arbitrary<Record<string, unknown>>;

// Payloads that break at least one constraint of the schema
const invalidPayloads: fc.Arbitrary<unknown> = fc
  .tuple(validPayloads, fc.constantFrom('missing', 'wrong_type', 'out_of_range', 'extra', 'not_an_object'))
  .map(([payload, violation]) => {
    switch (violation) {
      case 'missing': {
        const { name: _name, ...rest } = payload;
        return rest;
      }
      case 'wrong_type':
        return { ...payload, qty: 'many' };
      case 'out_of_range':
        return { ...payload, qty: -1 };
      case 'extra':
        return { ...payload, unexpected: true };
      default:
        return [payload];
    }
  });

describe('Validator — Property 3: Payload Validation Idempotence (valid)', () => {
  // Feature: daemonize, Property 3: validator idempotence (valid)
  it('a payload accepted once is accepted again', () => {
    fc.assert(
      fc.property(validPayloads, (payload) => {
        expect(validator.validate('create_customer', payload)).toBeNull();
        expect(validator.validate('create_customer', payload)).toBeNull();
      }),
      { numRuns: 200 }
    );
  });
});

describe('Validator — Property 4: Payload Validation Idempotence (invalid)', () => {
  // Feature: daemonize, Property 4: validator idempotence (invalid)
  it('a payload rejected once is rejected again, with the same violations', () => {
    fc.assert(
      fc.property(invalidPayloads, (payload) => {
        const first = validator.validate('create_customer', payload);
        const second = validator.validate('create_customer', payload);

        expect(first).not.toBeNull();
        expect(first!.errors.length).toBeGreaterThan(0);
        expect(second).toEqual(first);
      }),
      { numRuns: 200 }
    );
  });

  it('gives the same verdict twice for any payload, valid, invalid or arbitrary', () => {
    fc.assert(
      fc.property(fc.oneof(validPayloads, invalidPayloads, fc.anything()), (payload) => {
        const first = validator.validate('create_customer', payload);
        const second = validator.validate('create_customer', payload);

        expect(second).toEqual(first);
      }),
      { numRuns: 300 }
    );
  });
});

describe('Validator — formats and anyOf', () => {
  const inferred = {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      id: { type: 'string', format: 'uuid' },
      at: { type: 'string', format: 'date-time' },
      code: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    },
    required: ['email', 'code'],
  };
  const formatValidator = new Validator(new Map([['tool', inferred]]));

  it('accepts what the schema describes, with formats and alternatives', () => {
    fc.assert(
      fc.property(schemaArbitrary(inferred), (payload) => {
        expect(formatValidator.validate('tool', payload)).toBeNull();
      }),
      { numRuns: 200 }
    );
  });

  it('rejects a value that matches none of the alternatives', () => {
    expect(formatValidator.validate('tool', { email: 'a@example.com', code: true })).not.toBeNull();
    expect(formatValidator.validate('tool', { email: 'not an email', code: 'x' })).not.toBeNull();
  });
});

