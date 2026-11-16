import { describe, it, expect } from 'vitest';
import { Validator } from '../../src/validator/validator.js';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['name'],
};

describe('Validator', () => {
  const validator = new Validator(new Map([['create_customer', schema]]));

  it('returns null for a valid payload', () => {
    expect(validator.validate('create_customer', { name: 'Ada' })).toBeNull();
  });

  it('lists every violation with its location and never throws', () => {
    const result = validator.validate('create_customer', { notes: [1, 2] });

    expect(result?.errors.map((e) => e.instancePath).sort()).toEqual(['', '/notes/0', '/notes/1']);
    expect(result?.errors.every((e) => e.schemaPath !== '' && e.message !== '')).toBe(true);
  });

  it('accepts any payload for an action without a schema', () => {
    expect(validator.validate('unknown_action', { anything: true })).toBeNull();
  });

  it('validates a payload of about 1 MB within 50 ms', () => {
    const payload = { name: 'Ada', notes: Array.from({ length: 10000 }, () => 'x'.repeat(100)) };
    expect(JSON.stringify(payload).length).toBeGreaterThan(1_000_000);

    const startedAt = performance.now();
    const result = validator.validate('create_customer', payload);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toBeNull();
    expect(elapsedMs).toBeLessThan(50);
  });
});
