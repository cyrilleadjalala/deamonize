import { describe, it, expect } from 'vitest';
import { SchemaAccumulator } from '../../src/schema/schema-accumulator.js';
import { FormatAnnotator } from '../../src/schema/format-annotator.js';

const properties = (schema: Record<string, unknown>) => schema['properties'] as Record<string, Record<string, unknown>>;

describe('SchemaAccumulator', () => {
  it('widens an integer to a number once a decimal is observed', () => {
    const accumulator = new SchemaAccumulator();
    accumulator.observe({ qty: 2 });
    expect(properties(accumulator.getSchema()).qty.type).toBe('integer');

    accumulator.observe({ qty: 2.5 });
    expect(properties(accumulator.getSchema()).qty.type).toBe('number');

    // A number is never narrowed back
    accumulator.observe({ qty: 3 });
    expect(properties(accumulator.getSchema()).qty.type).toBe('number');
  });

  it('keeps both types as alternatives when a field is observed with different types', () => {
    const accumulator = new SchemaAccumulator();
    accumulator.observe({ code: 'abc' });
    accumulator.observe({ code: 5 });

    const branches = properties(accumulator.getSchema()).code['anyOf'] as Array<{ type: string }>;
    expect(branches.map((branch) => branch.type).sort()).toEqual(['integer', 'string']);
  });

  it('makes a field optional when it is missing from some observations', () => {
    const accumulator = new SchemaAccumulator();
    accumulator.observe({ name: 'Ada', vip: true });
    accumulator.observe({ name: 'Bob' });

    const schema = accumulator.getSchema();
    expect(schema['required']).toEqual(['name']);
    expect(Object.keys(properties(schema)).sort()).toEqual(['name', 'vip']);
    expect(schema['additionalProperties']).toBe(true);
  });

  it('counts the observations and starts from an empty object schema', () => {
    const accumulator = new SchemaAccumulator();
    expect(accumulator.count).toBe(0);
    expect(accumulator.getSchema()).toMatchObject({ type: 'object', properties: {}, required: [] });

    accumulator.observe({ a: 1 });
    accumulator.observe({ a: 2 });
    expect(accumulator.count).toBe(2);
  });

  it('merges nested objects field by field', () => {
    const accumulator = new SchemaAccumulator();
    accumulator.observe({ address: { city: 'Paris', zip: '75001' } });
    accumulator.observe({ address: { city: 'Lyon' } });

    const address = properties(accumulator.getSchema()).address;
    expect(address['required']).toEqual(['city']);
    expect(Object.keys(properties(address)).sort()).toEqual(['city', 'zip']);
  });
});

describe('FormatAnnotator', () => {
  const annotate = (field: string, values: unknown[]) => {
    const accumulator = new SchemaAccumulator();
    const observations = values.map((value) => ({ [field]: value }));
    observations.forEach((observation) => accumulator.observe(observation));
    return properties(new FormatAnnotator().annotate(accumulator.getSchema(), observations))[field];
  };

  it('annotates a field when at least 80% of its values match a format', () => {
    const emails = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'not an email'];

    expect(annotate('contact', emails).format).toBe('email');
  });

  it('does not annotate below the threshold', () => {
    const mixed = ['a@example.com', 'b@example.com', 'c@example.com', 'x', 'y'];

    expect(annotate('contact', mixed).format).toBeUndefined();
  });

  it('recognises uuids and ISO 8601 date-times', () => {
    expect(
      annotate('id', ['123e4567-e89b-42d3-a456-426614174000', '9b2f1c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f']).format
    ).toBe('uuid');
    expect(annotate('at', ['2026-11-15T10:00:00Z', '2026-11-16T08:30:00.250+01:00']).format).toBe('date-time');
  });

  it('ignores null values when computing the rate, and fields that are not strings', () => {
    // A field that is sometimes null is "string or null": the format goes on the string alternative
    const nullable = annotate('contact', ['a@example.com', null, 'b@example.com']);
    expect(nullable['anyOf']).toEqual(
      expect.arrayContaining([{ type: 'string', format: 'email' }, { type: 'null' }])
    );

    expect(annotate('qty', [1, 2, 3]).format).toBeUndefined();
  });

  it('annotates fields of nested objects', () => {
    const accumulator = new SchemaAccumulator();
    const observations = [{ owner: { email: 'a@example.com' } }, { owner: { email: 'b@example.com' } }];
    observations.forEach((observation) => accumulator.observe(observation));

    const schema = new FormatAnnotator().annotate(accumulator.getSchema(), observations);
    expect(properties(properties(schema).owner as Record<string, unknown>).email.format).toBe('email');
  });
});
